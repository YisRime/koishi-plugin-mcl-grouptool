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
 * 启动器配置定义
 * @description 包含各启动器的群组ID、对应群组列表和文件名匹配模式
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
} as const

/** 启动器名称类型 */
type LauncherName = keyof typeof LAUNCHER_CONFIGS

/**
 * 关键词配置接口
 * @interface KeywordConfig
 * @property {string} regex - 正则表达式
 * @property {string} reply - 回复内容
 */
interface KeywordConfig {
  regex: string
  reply: string
}

/**
 * 插件配置接口
 * @interface Config
 */
export interface Config {
  preventDup?: boolean
  mention?: boolean
  quote?: boolean
  fileReply?: boolean
  keywordReply?: boolean
  keywords?: KeywordConfig[]
  ocrKeywords?: KeywordConfig[]
  fwdKeywords?: { regex: string }[]
  enableForward?: boolean
  forwardTarget?: string
  cmdWhitelist?: string[]
  ocrReply?: boolean
  forwardOcr?: boolean
}

/** 插件配置 Schema */
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    ocrReply: Schema.boolean().default(false).description('启用图片识别'),
    fileReply: Schema.boolean().default(true).description('启用文件识别'),
    keywordReply: Schema.boolean().default(true).description('启用关键词回复'),
    enableForward: Schema.boolean().default(false).description('启用消息转发'),
    forwardOcr: Schema.boolean().default(false).description('转发图片识别内容'),
    forwardTarget: Schema.string().description('转发目标群'),
    cmdWhitelist: Schema.array(Schema.string()).description('命令操作白名单用户').role('table')
  }).description('权限开关配置'),
  Schema.object({
    preventDup: Schema.boolean().default(true).description('延迟发送提示'),
    quote: Schema.boolean().default(true).description('回复时引用消息'),
    mention: Schema.boolean().default(false).description('回复时@用户')
  }).description('自动回复配置'),
  Schema.object({
    keywords: Schema.array(Schema.object({
      regex: Schema.string().description('正则表达式'),
      reply: Schema.string().description('回复内容')
    })).description('回复关键词').role('table'),
    ocrKeywords: Schema.array(Schema.object({
      regex: Schema.string().description('正则表达式'),
      reply: Schema.string().description('回复内容')
    })).description('OCR 关键词').role('table'),
    fwdKeywords: Schema.array(Schema.object({
      regex: Schema.string().description('正则表达式')
    })).description('转发关键词').role('table')
  }).description('关键词配置')
])

/**
 * 插件主函数
 * @param ctx Koishi 上下文
 * @param config 插件配置
 */
export function apply(ctx: Context, config: Config) {
  const pending = new Map<string, NodeJS.Timeout>()

  /**
   * 构建回复消息元素
   * @param session 会话对象
   * @param content 回复内容
   * @param targetUserId 目标用户ID（可选）
   * @returns 消息元素数组
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
   * 检查关键词并发送回复
   * @param content 消息内容
   * @param keywords 关键词配置
   * @param session 会话对象
   * @returns 是否找到匹配的关键词
   */
  const checkKeywords = async (content: string, keywords: KeywordConfig[], session: any) => {
    for (const kw of keywords) {
      if (kw.regex && new RegExp(kw.regex, 'i').test(content)) {
        await session.send(buildReplyElements(session, kw.reply))
        return true
      }
    }
    return false
  }

  /**
   * 处理启动器文件检测和回复
   * @param session 会话对象
   * @param launcher 当前群对应的启动器
   * @param matched 匹配到的启动器
   */
  const handleLauncherFile = async (session: any, launcher: LauncherName, matched: LauncherName) => {
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
   * 检查用户是否在命令白名单中
   * @param userId 用户ID
   * @returns 是否在白名单中
   */
  const isUserWhitelisted = (userId: string) => config.cmdWhitelist?.includes(userId) ?? false

  /**
   * 处理OCR识别
   * @param imageElement 图片元素
   * @param session 会话对象
   * @returns OCR识别的文本
   */
  const handleOCR = async (imageElement: any, session: any) => {
    const ocrResult = await session.bot.internal.ocrImage(imageElement.attrs.src)
    if (Array.isArray(ocrResult) && ocrResult.length > 0) return ocrResult.map(item => item.text).filter(text => text?.trim()).join('\n')
    return null
  }

  /** 监听消息事件 */
  ctx.on('message', async (session) => {
    const { channelId, elements, content } = session
    // 处理消息转发
    if (config.enableForward && config.forwardTarget) {
      // 检查转发关键词
      if (config.fwdKeywords?.length && content && !config.fwdKeywords.some(kw => kw.regex && new RegExp(kw.regex, 'i').test(content))) return
      const senderInfo = `${session.userId}（${session.guildId || session.channelId}）`
      // 处理图片OCR转发
      const imageElement = elements?.find(el => el.type === 'img')
      if (imageElement && config.forwardOcr) {
        const ocrText = await handleOCR(imageElement, session)
        if (ocrText) await session.bot.sendMessage(config.forwardTarget, `${senderInfo}\n${ocrText}`)
      }
      // 转发文本消息
      if (content) await session.bot.sendMessage(config.forwardTarget, `${senderInfo}\n${content}`)
    }
    // 查找对应的启动器配置
    const launcher = Object.entries(LAUNCHER_CONFIGS).find(([, cfg]) =>
      (cfg.groups as readonly string[]).includes(channelId))?.[0] as LauncherName
    if (!launcher) return
    // 关键词回复
    if (config.keywordReply && content && config.keywords) await checkKeywords(content, config.keywords, session)
    // OCR关键词检测
    if (config.ocrReply && config.ocrKeywords) {
      const imageElement = elements?.find(el => el.type === 'img')
      if (imageElement) {
        const ocrText = await handleOCR(imageElement, session)
        if (ocrText) await checkKeywords(ocrText, config.ocrKeywords, session)
      }
    }
    // 文件检测
    if (config.fileReply) {
      const file = elements?.find(el => el.type === 'file')
      if (file) {
        const matched = Object.entries(LAUNCHER_CONFIGS).find(([, cfg]) =>
          cfg.pattern.test(file.attrs.file))?.[0] as LauncherName
        if (matched) await handleLauncherFile(session, launcher, matched)
      }
    }
    // 防重复发送
    if (config.preventDup && content && pending.has(channelId)) {
      const shouldCancel = Object.values(LAUNCHER_CONFIGS).some(cfg =>
        content.includes(cfg.groupId))
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
   * 发送预设回复命令
   */
  ctx.command('send <regexPattern> [target]', '发送预设回复')
    .option('list', '-l 查看关键词列表')
    .action(async ({ session, options }, regexPattern, target) => {
      if (!isUserWhitelisted(session.userId)) return
      if (options.list) {
        if (!config.keywords?.length) return '当前没有配置任何关键词'
        const keywordList = config.keywords.map((kw, index) =>
          `${index + 1}. ${kw.regex}`
        ).join('\n')
        return `可用关键词列表：\n${keywordList}`
      }
      if (!regexPattern) return '请提供正则表达式'
      const kw = config.keywords?.find(k => k.regex === regexPattern)
      if (!kw) return `未找到正则表达式 "${regexPattern}" 的配置`
      let targetUserId: string | null = null
      if (target) {
        const at = h.select(h.parse(target), 'at')[0]?.attrs?.id
        targetUserId = at || target.match(/@?(\d{5,10})/)?.[1] || null
      }
      await session.send(buildReplyElements(session, kw.reply, targetUserId))
    })
}
