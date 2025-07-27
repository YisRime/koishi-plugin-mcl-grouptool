import { Context, Session } from 'koishi'
import { Config } from '../index'
import { buildReplyElements } from '../utils'

type LauncherName = 'hmcl' | 'pcl' | 'bakaxl'

const LAUNCHER_CONFIGS = {
  hmcl: { groupId: '666546887', groups: ['633640264', '203232161', '201034984', '533529045', '744304553', '282845310', '482624681', '991620626', '657677715', '775084843'], pattern: /minecraft-exported-(crash-info|logs)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.(zip|log)$/i },
  pcl: { groupId: '978054335', groups: ['1028074835'], pattern: /错误报告-\d{4}-\d{1,2}-\d{1,2}_\d{2}\.\d{2}\.\d{2}\.zip$/i },
  bakaxl: { groupId: '958853931', groups: ['480455628', '377521448'], pattern: /BakaXL-ErrorCan-\d{14}\.json$/i }
} as const

export class FileReplyService {
  private pending = new Map<string, NodeJS.Timeout>()

  constructor(private ctx: Context, private config: Config) {}

  public async handleMessage(session: Session) {
    const { elements, channelId, content } = session
    const launcher = this.getLauncherByChannel(channelId)

    if (launcher) {
      // 启动器文件检测
      const file = elements?.find(el => el.type === 'file')
      if (file) {
        const fileName = file.attrs.file || ''
        const matched = this.detectLauncherFromFile(fileName)
        if (matched) await this.handleLauncherFile(session, launcher, matched)
      }

      // 防重复发送
      if (this.config.preventDup && content) this.checkCancelDelay(content, channelId)
    }
  }

  private getLauncherByChannel(channelId: string): LauncherName | null {
    return Object.entries(LAUNCHER_CONFIGS).find(([, cfg]) => (cfg.groups as readonly string[]).includes(channelId))?.[0] as LauncherName || null
  }

  private detectLauncherFromFile(fileName: string): LauncherName | null {
    return Object.entries(LAUNCHER_CONFIGS).find(([, cfg]) => cfg.pattern.test(fileName))?.[0] as LauncherName || null
  }

  private async handleLauncherFile(session: Session, launcher: LauncherName, matched: LauncherName): Promise<void> {
    const isCorrect = matched === launcher
    if (matched === 'bakaxl' && isCorrect) return
    const launcherConfig = LAUNCHER_CONFIGS[matched]
    const prefix = isCorrect ? '这里是' : '本群不解决其他启动器的报错问题，'
    const suffix = isCorrect ? '用户群，如果遇到' : '的'
    const msg = `${prefix} ${matched.toUpperCase()} ${suffix}游戏崩溃问题加这个群：${launcherConfig.groupId}`

    if (this.config.preventDup) {
      const timer = this.pending.get(session.channelId)
      if (timer) clearTimeout(timer)
      this.pending.set(session.channelId, setTimeout(async () => {
        await session.send(buildReplyElements(session, msg, undefined, this.config))
        this.pending.delete(session.channelId)
      }, 3000))
    } else {
      await session.send(buildReplyElements(session, msg, undefined, this.config))
    }
  }

  private checkCancelDelay(content: string, channelId: string): void {
    if (this.pending.has(channelId)) {
      const shouldCancel = Object.values(LAUNCHER_CONFIGS).some(cfg => content.includes(cfg.groupId))
      if (shouldCancel) {
        const timer = this.pending.get(channelId)
        if (timer) {
          clearTimeout(timer)
          this.pending.delete(channelId)
        }
      }
    }
  }
}
