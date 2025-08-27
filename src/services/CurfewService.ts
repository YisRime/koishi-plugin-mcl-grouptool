import { Context, Session } from 'koishi'
import { Config } from '..'
import { isUserWhitelisted } from '../utils'

/**
 * @class CurfewService
 * @description 管理群组的宵禁功能。在指定时间内，若白名单用户不活跃，则自动开启全体禁言。
 * @version 2.0 - Refactored to use setTimeout for scheduling, reducing constant polling.
 */
export class CurfewService {
  private readonly ctx: Context
  private readonly config: Config
  private readonly targetGroupIds = ['666546887', '978054335']

  private whitelistLastActivity: Map<string, number> = new Map()
  private isCurfewMuted: Map<string, boolean> = new Map()
  private newMemberDisposers: Map<string, () => void> = new Map()

  /** 主调度定时器，用于预约下一个宵禁开始或结束事件 */
  private mainScheduler: NodeJS.Timeout
  /** 宵禁期间的内部检查定时器，用于检查白名单用户活跃度 */
  private curfewCheckTimer: NodeJS.Timeout

  constructor(ctx: Context, config: Config) {
    this.ctx = ctx
    this.config = config

    if (!this.config.curfewTime || !this.parseCurfewTime()) {
      return
    }

    // 启动主调度器，开始预约下一次事件
    this.scheduleNextEvent()

    this.ctx.on('dispose', () => {
      // 插件卸载时，清除所有定时器和监听器
      if (this.mainScheduler) clearTimeout(this.mainScheduler)
      if (this.curfewCheckTimer) clearInterval(this.curfewCheckTimer)

      for (const disposer of this.newMemberDisposers.values()) {
        disposer()
      }
      this.newMemberDisposers.clear()
    })
  }

  // --- 核心调度逻辑 ---

  /**
   * @method scheduleNextEvent
   * @description 计算并预约下一个事件（宵禁开始或结束）。
   */
  private scheduleNextEvent(): void {
    if (this.mainScheduler) clearTimeout(this.mainScheduler)

    const times = this.parseCurfewTime()
    if (!times) return

    const now = new Date()
    const currentHour = now.getHours() + now.getMinutes() / 60

    let isCurrentlyInCurfew: boolean
    if (times.start > times.end) {
      isCurrentlyInCurfew = currentHour >= times.start || currentHour < times.end
    } else {
      isCurrentlyInCurfew = currentHour >= times.start && currentHour < times.end
    }

    let nextEventTime: Date
    let nextAction: () => void

    if (isCurrentlyInCurfew) {
      // 当前在宵禁期内，预约“结束宵禁”
      nextEventTime = this.getTargetDate(times.end)
      if (nextEventTime <= now) { // 如果结束时间是次日，则加一天
        nextEventTime.setDate(nextEventTime.getDate() + 1)
      }
      nextAction = this.onCurfewEnd.bind(this)

      // 立即执行一次宵禁开始的逻辑，因为可能是在插件启动/重载时就处于宵禁期
      this.onCurfewStart()

    } else {
      // 当前不在宵禁期，预约“开始宵禁”
      nextEventTime = this.getTargetDate(times.start)
      if (nextEventTime <= now) { // 如果开始时间已过，则预约次日的
        nextEventTime.setDate(nextEventTime.getDate() + 1)
      }
      nextAction = this.onCurfewStart.bind(this)
    }

    const delay = nextEventTime.getTime() - now.getTime()
    this.mainScheduler = setTimeout(nextAction, delay)
  }

  /**
   * @method onCurfewStart
   * @description 宵禁开始时触发的函数。
   */
  private onCurfewStart(): void {
    // 立即检查一次，并启动宵禁期间的周期性检查（每5分钟一次）
    this.checkWhitelistActivityAndMute()
    this.curfewCheckTimer = setInterval(() => this.checkWhitelistActivityAndMute(), 5 * 60 * 1000)

    // 预约下一次事件（结束宵禁）
    this.scheduleNextEvent()
  }

  /**
   * @method onCurfewEnd
   * @description 宵禁结束时触发的函数。
   */
  private async onCurfewEnd(): Promise<void> {
    // 停止宵禁期间的检查器
    if (this.curfewCheckTimer) clearInterval(this.curfewCheckTimer)

    // 解除所有目标群组的禁言
    for (const groupId of this.targetGroupIds) {
      if (this.isCurfewMuted.get(groupId)) {
        await this.setGroupMute(groupId, false)
      }
    }

    // 预约下一次事件（开始宵禁）
    this.scheduleNextEvent()
  }

  /**
   * @method checkWhitelistActivityAndMute
   * @description 检查白名单用户活跃度并决定是否禁言，此函数只在宵禁期间被调用。
   */
  private async checkWhitelistActivityAndMute(): Promise<void> {
    for (const groupId of this.targetGroupIds) {
      // 如果已禁言，则无需重复操作
      if (this.isCurfewMuted.get(groupId)) continue

      const lastActivity = this.whitelistLastActivity.get(groupId) ?? 0
      // 不活跃时间判断，这里可以修改，例如 15 分钟
      const inactiveThreshold = Date.now() - 15 * 60 * 1000

      if (lastActivity < inactiveThreshold) {
        await this.setGroupMute(groupId, true)
      }
    }
  }

  // --- 辅助与事件处理函数 ---

  public handleMessage(session: Session): void {
    if (
      session.guildId &&
      this.targetGroupIds.includes(session.guildId) &&
      isUserWhitelisted(session.userId, this.config)
    ) {
      this.whitelistLastActivity.set(session.guildId, Date.now())
    }
  }

  private async handleNewMember(session: Session): Promise<void> {
    if (session.guildId && this.isCurfewMuted.get(session.guildId)) {
      try {
        const message = `本群现在处于宵禁中，寻求帮助的请明早再来吧。`
        await session.send(message)
      } catch (error) {
        this.ctx.logger.warn(`发送宵禁欢迎消息至群 ${session.guildId} 失败:`, error)
      }
    }
  }

  private parseCurfewTime(): { start: number; end: number } | null {
    const timeRegex = /^(\d{1,2}(?:\.\d{1,2})?)-(\d{1,2}(?:\.\d{1,2})?)$/
    const match = this.config.curfewTime?.match(timeRegex)
    if (!match) return null

    const start = parseFloat(match[1])
    const end = parseFloat(match[2])

    if (isNaN(start) || isNaN(end) || start < 0 || start >= 24 || end < 0 || end >= 24) {
      this.ctx.logger.warn(`无效的宵禁时间值: ${this.config.curfewTime}`)
      return null
    }

    return { start, end }
  }

  /**
   * @method getTargetDate
   * @description 根据小时数（可为小数）获取今天的目标Date对象
   */
  private getTargetDate(decimalHour: number): Date {
    const date = new Date()
    const hours = Math.floor(decimalHour)
    const minutes = Math.round((decimalHour - hours) * 60)
    date.setHours(hours, minutes, 0, 0)
    return date
  }

  private async setGroupMute(groupId: string, mute: boolean): Promise<void> {
    const bot = this.ctx.bots.find(b => b.platform === 'onebot')
    if (!bot) {
      this.ctx.logger.warn('未找到可用的 OneBot 实例')
      return
    }

    try {
      await (bot as any).onebot.setGroupWholeBan(+groupId, mute)
      this.isCurfewMuted.set(groupId, mute)

      if (mute) {
        if (!this.newMemberDisposers.has(groupId)) {
          const disposer = this.ctx.on('guild-member-added', (session) => {
            if (session.guildId === groupId) this.handleNewMember(session)
          })
          this.newMemberDisposers.set(groupId, disposer)
        }
        const notification = `宵禁时间到！时间已经不早了，解决问题请明早再来吧`
        await bot.sendMessage(groupId, notification).catch(e => {
          this.ctx.logger.warn(`发送宵禁开始通知到群 ${groupId} 失败:`, e)
        })
      } else {
        const disposer = this.newMemberDisposers.get(groupId)
        if (disposer) {
          disposer()
          this.newMemberDisposers.delete(groupId)
        }
        this.whitelistLastActivity.delete(groupId)
      }
    } catch (error) {
      this.ctx.logger.warn(`在群 ${groupId} ${mute ? '开启' : '关闭'}全体禁言时失败:`, error)
      this.isCurfewMuted.set(groupId, !mute)
    }
  }
}
