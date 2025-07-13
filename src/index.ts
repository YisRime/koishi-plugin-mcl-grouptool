import { Context, Schema, h } from 'koishi'
import {} from 'koishi-plugin-adapter-onebot'
import {
  buildReplyElements,
  isUserWhitelisted,
  handleFileDownload,
  handleReplyMessage,
  handleOCR,
  checkKeywords,
  handleForward,
  handleLauncherFile,
  checkCancelDelay,
  getLauncherByChannel,
  detectLauncherFromFile
} from './services'

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

interface KeywordConfig {
  regex: string
  reply: string
}

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
  whitelist?: string[]
  ocrReply?: boolean
  forwardOcr?: boolean
  fileRecord?: boolean
  additionalGroups?: string[]
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    fileReply: Schema.boolean().default(false).description('启用报错指引'),
    fileRecord: Schema.boolean().default(false).description('启用报告记录'),
    keywordReply: Schema.boolean().default(false).description('启用关键词回复'),
    ocrReply: Schema.boolean().default(false).description('启用图片识别'),
    enableForward: Schema.boolean().default(false).description('启用消息转发'),
    forwardOcr: Schema.boolean().default(false).description('转发图片识别')
  }).description('开关配置'),
  Schema.object({
    preventDup: Schema.boolean().default(true).description('延迟发送提示'),
    quote: Schema.boolean().default(true).description('回复时引用消息'),
    mention: Schema.boolean().default(false).description('回复时@用户'),
    forwardTarget: Schema.string().description('转发目标群'),
    additionalGroups: Schema.array(Schema.string()).description('报告记录群').role('table'),
    whitelist: Schema.array(Schema.string()).description('白名单用户').role('table')
  }).description('参数配置'),
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

export function apply(ctx: Context, config: Config) {
  ctx.command('send <regexPattern> [target]', '发送预设回复')
    .option('list', '-l 查看关键词列表')
    .action(async ({ session, options }, regexPattern, target) => {
      if (!isUserWhitelisted(session.userId, config)) return;
      if (options.list) {
        if (!config.keywords?.length) return '当前没有配置任何关键词'
        const keywordList = config.keywords.map((kw, index) =>
          `${index + 1}. ${kw.regex}`
        ).join('\n')
        return `可用关键词列表：\n${keywordList}\n\n使用方法: send <正则表达式> [目标用户]`
      }
      if (!regexPattern) return '请提供正则表达式\n使用 send -l 查看可用关键词列表'
      const kw = config.keywords?.find(k => k.regex === regexPattern)
      if (!kw) return `未找到正则表达式 "${regexPattern}" 的配置\n使用 send -l 查看可用关键词列表`
      let targetUserId: string | null = null
      if (target) {
        const at = h.select(h.parse(target), 'at')[0]?.attrs?.id
        targetUserId = at || target.match(/@?(\d{5,10})/)?.[1] || null
      }
      try {
        await session.send(buildReplyElements(session, kw.reply, targetUserId, config))
        return ''
      } catch (error) {
        return '发送预设回复失败'
      }
    })

  ctx.on('message', async (session) => {
    const { channelId, elements, content } = session
    try {
      // 处理回复消息
      if (session.quote?.id) await handleReplyMessage(session, config)
      // 消息转发
      if (config.enableForward) await handleForward(session, config)
      const launcher = getLauncherByChannel(channelId)
      // 关键词回复
      if (config.keywordReply && content && config.keywords) await checkKeywords(content, config.keywords, session, config)
      // OCR关键词检测
      if (config.ocrReply && config.ocrKeywords) {
        const imageElement = elements?.find(el => el.type === 'img')
        if (imageElement) {
          const ocrText = await handleOCR(imageElement, session)
          if (ocrText) await checkKeywords(ocrText, config.ocrKeywords, session, config)
        }
      }
      // 文件下载和记录
      if (config.fileRecord) {
        const file = elements?.find(el => el.type === 'file')
        if (file) await handleFileDownload(file, session, config)
      }
      // 启动器文件检测
      if (config.fileReply && launcher) {
        const file = elements?.find(el => el.type === 'file')
        if (file) {
          const fileName = file.attrs.file || ''
          const matched = detectLauncherFromFile(fileName)
          if (matched) await handleLauncherFile(session, launcher, matched, config)
        }
      }
      // 防重复发送
      if (config.preventDup && content && launcher) checkCancelDelay(content, channelId)
    } catch (error) {
      console.error('处理消息事件时发生错误:', error)
    }
  })
}
