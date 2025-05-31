import { Context, Schema, h } from 'koishi'
import {} from 'koishi-plugin-adapter-onebot'

export const name = 'mcl-grouptool'

export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">📌 插件说明</h2>
  <p>📖 <strong>使用文档</strong>：请点击左上角的 <strong>插件主页</strong> 查看插件使用文档</p>
  <p>🔍 <strong>更多插件</strong>：可访问 <a href="https://github.com/YisRime" style="color:#4a6ee0;text-decoration:none;">苡淞的 GitHub</a> 查看本人的所有插件</p>
</div>

<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #e0574a;">❤️ 支持与反馈</h2>
  <p>🌟 喜欢这个插件？请在 <a href="https://github.com/YisRime" style="color:#e0574a;text-decoration:none;">GitHub</a> 上给我一个 Star！</p>
  <p>🐛 遇到问题？请通过 <strong>Issues</strong> 提交反馈，或加入 QQ 群 <a href="https://qm.qq.com/q/PdLMx9Jowq" style="color:#e0574a;text-decoration:none;"><strong>855571375</strong></a> 进行交流</p>
</div>
`

/**
 * 启动器配置信息
 */
const LAUNCHER_CONFIGS = {
  hmcl: {
    groupId: '666546887',
    groups: ['633640264', '203232161', '201034984', '533529045', '744304553', '282845310', '482624681', '991620626', '657677715', '775084843'],
    pattern: /minecraft-exported-(crash-info|logs)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.(zip|log)$/i
  },
  pcl: {
    groupId: '978054335',
    groups: ['1028074835'],
    pattern: /错误报告-\d{4}-\d{1,2}-\d{1,2}_\d{2}\.\d{2}\.\d{2}\.zip$/i
  },
  bakaxl: {
    groupId: '377521448',
    groups: ['480455628', '377521448'],
    pattern: /BakaXL-ErrorCan-\d{14}\.json$/i
  }
}

/**
 * 启动器名称类型
 */
type LauncherName = keyof typeof LAUNCHER_CONFIGS

/**
 * 关键词配置接口
 */
interface Keyword {
  /** 关键词文本 */
  keyword: string
  /** 回复内容 */
  reply: string
  /** 可选的正则表达式 */
  regex?: string
}

/**
 * 插件配置接口
 */
export interface Config {
  /** 用户白名单 */
  whitelist?: string[]
  /** 是否启用重复发送防护 */
  preventDup?: boolean
  /** 回复时是否@用户 */
  mention?: boolean
  /** 回复时是否引用消息 */
  quote?: boolean
  /** 关键词配置列表 */
  keywords?: Keyword[]
  /** 是否启用转发功能 */
  enableForward?: boolean
  /** 转发类型：群聊或私聊 */
  forwardType?: 'group' | 'user'
  /** 转发目标ID */
  forwardTarget?: string
  /** 是否启用OCR识别 */
  enableOCR?: boolean
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    preventDup: Schema.boolean().default(true).description('延迟发送提示'),
    quote: Schema.boolean().default(true).description('回复时引用消息'),
    mention: Schema.boolean().default(false).description('回复时@用户')
  }).description('自动回复配置'),
  Schema.object({
    enableForward: Schema.boolean().default(false).description('启用消息转发'),
    enableOCR: Schema.boolean().default(false).description('启用OCR识别'),
    forwardType: Schema.union(['group', 'user']).description('转发类型').default('user'),
    forwardTarget: Schema.string().description('转发目标ID')
  }).description('消息转发配置'),
  Schema.object({
    whitelist: Schema.array(Schema.string()).description('用户白名单'),
    keywords: Schema.array(Schema.object({
      keyword: Schema.string().description('关键词'),
      reply: Schema.string().description('回复内容'),
      regex: Schema.string().description('正则表达式')
    })).description('关键词配置').role('table')
  }).description('关键词回复配置')
])

/**
 * 插件主函数
 * @param ctx Koishi上下文
 * @param config 插件配置
 */
export function apply(ctx: Context, config: Config) {
  const pending = new Map<string, NodeJS.Timeout>()

  /**
   * 检查用户是否在白名单中
   * @param userId 用户ID
   * @returns 如果用户在白名单中或未设置白名单则返回true
   */
  const isUserWhitelisted = (userId: string): boolean =>
    !config.whitelist || config.whitelist.includes(userId)

  /**
   * 构建回复元素
   * @param session 会话对象
   * @param content 回复内容
   * @param targetUserId 目标用户ID（可选）
   * @returns 元素数组
   */
  const buildReplyElements = (session: any, content: string, targetUserId?: string) => {
    const elements = []
    if (config.quote && session.messageId) elements.push(h('quote', { id: session.messageId }))
    if (targetUserId) {
      elements.push(h('at', { id: targetUserId }), h('text', { content: ' ' }))
    } else if (config.mention) {
      elements.push(h('at', { id: session.userId }), h('text', { content: ' ' }))
    }
    elements.push(h('text', { content }))
    return elements
  }

  /**
   * 查找对应的启动器
   * @param channelId 频道ID
   * @returns 启动器名称或null
   */
  const findLauncher = (channelId: string): LauncherName | null => {
    for (const [name, config] of Object.entries(LAUNCHER_CONFIGS)) if (config.groups.includes(channelId)) return name as LauncherName
    return null
  }

  /**
   * 查找匹配的启动器文件
   * @param filename 文件名
   * @returns 启动器名称或null
   */
  const findMatchedLauncher = (filename: string): LauncherName | null => {
    for (const [name, config] of Object.entries(LAUNCHER_CONFIGS)) if (config.pattern.test(filename)) return name as LauncherName
    return null
  }

  /**
   * 监听消息事件，处理图片转发、启动器文件识别和关键词回复
   */
  ctx.on('message', async (session) => {
    const { channelId, elements, content } = session
    // 处理消息转发
    if (config.enableForward && config.forwardTarget) await handleMessageForward(session, elements, content)
    // 查找对应的启动器
    const launcher = findLauncher(channelId)
    if (!launcher) return
    // 处理关键词回复
    if (content && config.keywords) {
      for (const kw of config.keywords) {
        if (kw.regex && new RegExp(kw.regex, 'i').test(content)) {
          await session.send(buildReplyElements(session, kw.reply))
          return
        }
      }
    }
    // 处理文件识别
    const file = elements?.find(el => el.type === 'file')
    if (file) {
      const matched = findMatchedLauncher(file.attrs.file)
      if (matched) await handleLauncherFile(session, launcher, matched)
    }
    // 处理重复发送防护
    if (config.preventDup && content && pending.has(channelId)) {
      const shouldCancel = Object.values(LAUNCHER_CONFIGS).some(launcherConfig => content.includes(launcherConfig.groupId))
      if (shouldCancel) {
        const timer = pending.get(channelId)
        if (timer) {
          clearTimeout(timer)
          pending.delete(channelId)
        }
      }
    }
  })

  /**
   * 处理消息转发
   * @param session 会话对象
   * @param elements 消息元素
   * @param content 消息内容
   */
  async function handleMessageForward(session: any, elements: any[], content: string) {
    const sendForward = config.forwardType === 'group'
      ? session.bot.sendMessage
      : session.bot.sendPrivateMessage
    // 处理图片OCR识别
    const imageElement = elements?.find(el => el.type === 'img')
    if (imageElement && config.enableOCR) {
      try {
        const ocrResult = await session.bot.internal.ocrImage(imageElement.attrs.src)
        if (Array.isArray(ocrResult) && ocrResult.length > 0) {
          const extractedTexts = ocrResult.map(item => item.text).filter(text => text?.trim())
          if (extractedTexts.length > 0) {
            const senderInfo = `${session.author.nickname || session.userId}（${session.guildId || session.channelId}）`
            await sendForward.call(session.bot, config.forwardTarget, senderInfo)
            await sendForward.call(session.bot, config.forwardTarget, `${extractedTexts.join('\n')}`)
          }
        }
      } catch {}
    }
    // 转发JSON格式消息
    if (content) {
      try {
        JSON.parse(content)
        const senderInfo = `${session.author.nickname || session.userId}（${session.guildId || session.channelId}）`
        await sendForward.call(session.bot, config.forwardTarget, senderInfo)
        await sendForward.call(session.bot, config.forwardTarget, content)
      } catch {}
    }
  }

  /**
   * 处理启动器文件识别
   * @param session 会话对象
   * @param launcher 当前启动器
   * @param matched 匹配的启动器
   */
  async function handleLauncherFile(session: any, launcher: LauncherName, matched: LauncherName) {
    const isCorrect = matched === launcher
    if (matched === 'bakaxl' && isCorrect) return
    const launcherConfig = LAUNCHER_CONFIGS[matched]
    const prefix = isCorrect ? '这里是' : '本群不解决其他启动器的报错问题，'
    const suffix = isCorrect ? '用户群，如果遇到' : '的'
    const msg = `${prefix} ${matched.toUpperCase()} ${suffix}游戏崩溃问题加这个群：${launcherConfig.groupId}`
    if (config.preventDup) {
      const timer = pending.get(session.channelId)
      if (timer) clearTimeout(timer)
      pending.set(session.channelId, setTimeout(async () => {
        await session.send(buildReplyElements(session, msg))
        pending.delete(session.channelId)
      }, 3000))
    } else {
      await session.send(buildReplyElements(session, msg))
    }
  }

  /**
   * 发送命令 - 发送预设关键词回复
   */
  ctx.command('send <keyword> [target]', '发送预设回复')
    .option('list', '-l 查看关键词列表')
    .action(async ({ session, options }, keyword, target) => {
      if (!isUserWhitelisted(session.userId)) return
      if (options.list) {
        if (!config.keywords?.length) return '当前没有配置任何关键词'
        const keywordList = config.keywords.map((kw, index) =>
          `${index + 1}. ${kw.keyword}${kw.regex ? ' (正则)' : ''}`
        ).join('\n')
        return `可用关键词列表：\n${keywordList}`
      }
      if (!keyword) return '请提供关键词'
      const kw = config.keywords?.find(k => k.keyword === keyword)
      if (!kw) return `未找到关键词 "${keyword}" 的配置`
      let targetUserId: string | null = null
      if (target) {
        const at = h.select(h.parse(target), 'at')[0]?.attrs?.id
        targetUserId = at || target.match(/@?(\d{5,10})/)?.[1] || null
      }
      await session.send(buildReplyElements(session, kw.reply, targetUserId))
    })
}
