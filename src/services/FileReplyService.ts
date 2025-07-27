import { Context, Session } from 'koishi'
import { Config } from '../index'
import { buildReplyElements } from '../utils'

type LauncherName = 'hmcl' | 'pcl' | 'bakaxl'

const MULTI_LAUNCHER_GROUP_ID = '958853931'

const LAUNCHER_CONFIGS = {
  hmcl: {
    name: 'HMCL',
    groupId: '666546887',
    groups: ['633640264', '203232161', '201034984', '533529045', '744304553', '282845310', '482624681', '991620626', '657677715', '775084843'],
    pattern: /minecraft-exported-(crash-info|logs)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.(zip|log)$/i
  },
  pcl: {
    name: 'PCL',
    groupId: '978054335',
    groups: ['1028074835'],
    pattern: /错误报告-\d{4}-\d{1,2}-\d{1,2}_\d{2}\.\d{2}\.\d{2}\.zip$/i
  },
  bakaxl: {
    name: 'BakaXL',
    groupId: MULTI_LAUNCHER_GROUP_ID, // 当其他群遇到 BakaXL 文件时，指向多功能群
    groups: ['480455628', '377521448', MULTI_LAUNCHER_GROUP_ID], // BakaXL 文件在这些群里是“正确的”
    pattern: /BakaXL-ErrorCan-\d{14}\.json$/i
  }
} as const

export class FileReplyService {
  private pending = new Map<string, NodeJS.Timeout>()

  constructor(private ctx: Context, private config: Config) {}

  public async handleMessage(session: Session) {
    const { elements, channelId, content } = session
    const launcher = this.getLauncherByChannel(channelId)

    // 只有在明确归属的群组（非多功能群）才执行主要逻辑
    if (launcher) {
      // 启动器文件检测
      const file = elements?.find(el => el.type === 'file')
      if (file) {
        const fileName = file.attrs.file || ''
        const matched = this.detectLauncherFromFile(fileName)
        if (matched) {
          await this.handleLauncherFile(session, launcher, matched)
        }
      }

      // 防重复发送逻辑保持不变
      if (this.config.preventDup && content) {
        this.checkCancelDelay(content, channelId)
      }
    }
  }

  private getLauncherByChannel(channelId: string): LauncherName | null {
    // 注意：这里的查找顺序可能影响到多功能群的归属，当前归属给BakaXL是符合逻辑的
    return (Object.entries(LAUNCHER_CONFIGS).find(([, cfg]) => (cfg.groups as readonly string[]).includes(channelId))?.[0] as LauncherName) || null
  }

  private detectLauncherFromFile(fileName: string): LauncherName | null {
    return (Object.entries(LAUNCHER_CONFIGS).find(([, cfg]) => cfg.pattern.test(fileName))?.[0] as LauncherName) || null
  }

  /**
   * 文件处理逻辑
   * @param session 会话
   * @param launcher 当前群组的启动器类型
   * @param matched 文件匹配到的启动器类型
   */
  private async handleLauncherFile(session: Session, launcher: LauncherName, matched: LauncherName): Promise<void> {
    // 规则 1: 如果在多功能群，则接受任何类型的文件，不作提示
    if (session.channelId === MULTI_LAUNCHER_GROUP_ID) {
      return
    }

    // 规则 2: 如果文件类型与当前群组类型匹配，说明发送正确，不作提示
    if (matched === launcher) {
      return
    }

    // 规则 3: 文件与群组不匹配，发送指引提示
    const currentLauncherInfo = LAUNCHER_CONFIGS[launcher]
    const matchedLauncherInfo = LAUNCHER_CONFIGS[matched]

    const msg = `本群为 ${currentLauncherInfo.name} 用户群，检测到您发送的是 ${matchedLauncherInfo.name} 的文件。如果需要帮助，请前往对应的用户群：${matchedLauncherInfo.groupId}`

    if (this.config.preventDup) {
      const timer = this.pending.get(session.channelId)
      if (timer) clearTimeout(timer)
      this.pending.set(
        session.channelId,
        setTimeout(async () => {
          await session.send(buildReplyElements(session, msg, undefined, this.config))
          this.pending.delete(session.channelId)
        }, 3000)
      )
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
