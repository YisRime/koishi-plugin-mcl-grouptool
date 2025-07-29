import { Context, Session } from 'koishi'
import { Config } from '../index'
import { buildReplyElements } from '../utils'

// 定义启动器名称的类型别名
type LauncherName = 'hmcl' | 'pcl' | 'bakaxl'

// 多启动器问题交流群的群号
const MULTI_LAUNCHER_GROUP_ID = '958853931'

// 各个启动器的相关配置
const LAUNCHER_CONFIGS = {
  hmcl: {
    name: 'HMCL',
    groupId: '666546887', // 主要群号
    groups: ['633640264', '203232161', '201034984', '533529045', '744304553', '282845310', '482624681', '991620626', '657677715', '775084843'], // 所有相关群号
    pattern: /minecraft-exported-(crash-info|logs)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.(zip|log)$/i, // 匹配错误文件的正则表达式
  },
  pcl: {
    name: 'PCL',
    groupId: '978054335',
    groups: ['1028074835'],
    pattern: /错误报告-\d{4}-\d{1,2}-\d{1,2}_\d{2}\.\d{2}\.\d{2}\.zip$/i,
  },
  bakaxl: {
    name: 'BakaXL',
    groupId: MULTI_LAUNCHER_GROUP_ID, // BakaXL 的主群同时也是多功能群
    groups: ['480455628', '377521448', MULTI_LAUNCHER_GROUP_ID],
    pattern: /BakaXL-ErrorCan-\d{14}\.json$/i,
  },
} as const

/**
 * @class FileReplyService
 * @description 负责处理用户发送的错误报告文件，并根据文件类型和所在群组，引导用户到正确的群组进行提问。
 */
export class FileReplyService {
  // 用于存储待发送消息的定时器，以实现延迟发送和防刷屏功能
  private pending = new Map<string, NodeJS.Timeout>()

  constructor(private ctx: Context, private config: Config) {}

  /**
   * @method handleMessage
   * @description 消息事件的主要处理函数。
   * @param session 当前会话对象
   */
  public async handleMessage(session: Session): Promise<void> {
    const { elements, channelId, content } = session
    const launcher = this.getLauncherByChannel(channelId)

    // 仅在已明确归属启动器的群组中（而非多功能群）执行主要逻辑
    if (launcher) {
      const fileElement = elements?.find(el => el.type === 'file')
      // 如果消息中包含文件元素
      if (fileElement) {
        const fileName = fileElement.attrs.file || ''
        const matchedLauncher = this.detectLauncherFromFile(fileName)
        // 如果文件名匹配到了某个启动器的格式
        if (matchedLauncher) {
          await this.handleLauncherFile(session, launcher, matchedLauncher)
        }
      }

      // 如果开启了防刷屏，则检查后续消息是否可以取消延迟提示
      if (this.config.preventDup && content) {
        this.checkCancelDelay(content, channelId)
      }
    }
  }

  /**
   * @method getLauncherByChannel
   * @description 根据群号判断当前群组属于哪个启动器。
   * @param channelId 频道（群）ID
   * @returns 启动器名称或 null
   */
  private getLauncherByChannel(channelId: string): LauncherName | null {
    // 注意：查找顺序会影响多功能群的归属，当前设计将多功能群归属于 BakaXL 是符合预期的。
    const entry = Object.entries(LAUNCHER_CONFIGS).find(([, cfg]) => (cfg.groups as readonly string[]).includes(channelId))
    return (entry?.[0] as LauncherName) || null
  }

  /**
   * @method detectLauncherFromFile
   * @description 根据文件名检测文件属于哪个启动器。
   * @param fileName 文件名
   * @returns 启动器名称或 null
   */
  private detectLauncherFromFile(fileName: string): LauncherName | null {
    const entry = Object.entries(LAUNCHER_CONFIGS).find(([, cfg]) => cfg.pattern.test(fileName))
    return (entry?.[0] as LauncherName) || null
  }

  /**
   * @method handleLauncherFile
   * @description 处理匹配到的启动器文件的核心逻辑。
   * @param session 当前会话
   * @param launcher 当前群组的启动器类型
   * @param matched 文件所匹配到的启动器类型
   */
  private async handleLauncherFile(session: Session, launcher: LauncherName, matched: LauncherName): Promise<void> {
    // 规则 1: 如果在多功能群，则接受任何类型的文件，不作任何提示。
    if (session.channelId === MULTI_LAUNCHER_GROUP_ID) {
      return
    }

    // 规则 2: 如果文件类型与当前群组类型匹配，说明发送正确，不作提示。
    if (matched === launcher) {
      return
    }

    // 规则 3: 文件与群组不匹配，发送指引提示。
    const currentLauncherInfo = LAUNCHER_CONFIGS[launcher]
    const matchedLauncherInfo = LAUNCHER_CONFIGS[matched]

    const msg = `本群为「${currentLauncherInfo.name}」交流群，请前往「${matchedLauncherInfo.name}」群（${matchedLauncherInfo.groupId}）解决问题。`

    // 如果开启了防刷屏功能
    if (this.config.preventDup) {
      const timer = this.pending.get(session.channelId)
      if (timer) clearTimeout(timer) // 清除上一个待发送的提示

      // 设置一个 3 秒的延迟，如果在延迟期间用户发送了正确群号，则取消本次提示
      this.pending.set(
        session.channelId,
        setTimeout(async () => {
          await session.send(buildReplyElements(session, msg, undefined, this.config))
          this.pending.delete(session.channelId) // 发送后清除定时器
        }, 3000),
      )
    } else {
      // 直接发送提示
      await session.send(buildReplyElements(session, msg, undefined, this.config))
    }
  }

  /**
   * @method checkCancelDelay
   * @description 检查用户发送的后续消息内容，如果包含了任一启动器群号，则取消待发送的指引消息。
   * @param content 消息内容
   * @param channelId 频道（群）ID
   */
  private checkCancelDelay(content: string, channelId: string): void {
    if (this.pending.has(channelId)) {
      // 检查消息中是否包含了任何一个已知启动器的群号
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
