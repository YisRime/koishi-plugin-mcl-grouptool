import { Context, Schema, h } from 'koishi'
import {} from 'koishi-plugin-adapter-onebot'
import { buildReplyElements, isUserWhitelisted } from './utils'
import { FileRecordService } from './services/FileRecordService'
import { FileReplyService } from './services/FileReplyService'
import { KeywordReplyService } from './services/KeywordReplyService'
import { OcrReplyService } from './services/OcrReplyService'
import { ForwardingService } from './services/ForwardingService'

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
 * 关键词配置接口
 */
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
  // 实例化所有可能用到的服务
  const fileReplyService = config.fileReply ? new FileReplyService(ctx, config) : null
  const keywordReplyService = config.keywordReply ? new KeywordReplyService(ctx, config) : null
  const ocrReplyService = config.ocrReply ? new OcrReplyService(ctx, config) : null
  const forwardingService = config.enableForward ? new ForwardingService(ctx, config) : null
  const fileRecordService = config.fileRecord ? new FileRecordService(ctx, config) : null

  // 仅在有预设回复时注册 send 命令
  if (config.keywords?.length) {
    ctx.command('send <regexPattern> [target]', '发送预设回复')
      .option('list', '-l 查看关键词列表')
      .action(async ({ session, options }, regexPattern, target) => {
        if (!isUserWhitelisted(session.userId, config)) return
        if (options.list) {
          const keywordList = config.keywords.map((kw, index) => `${index + 1}. ${kw.regex}`).join('\n')
          return `可用关键词列表：\n${keywordList}\n\n使用方法: send <正则表达式> [目标用户]`
        }
        if (!regexPattern) return '请提供正则表达式\n使用 send -l 查看可用关键词列表'
        const kw = config.keywords.find(k => k.regex === regexPattern)
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
  }

  // 仅在开启了任何一个功能时才注册消息监听器
  const needsMessageListener = fileReplyService || keywordReplyService || ocrReplyService || forwardingService || fileRecordService
  if (needsMessageListener) {
    ctx.on('message', async (session) => {
      try {
        // 文件下载和记录（如果启用）
        if (fileRecordService) {
          const file = session.elements?.find(el => el.type === 'file')
          if (file) {
            // 注意: FileRecordService 现在需要一个处理文件上传的入口方法
            await fileRecordService.handleFile(file, session)
          }
          // FileRecordService 也需要一个处理所有消息的入口方法
          await fileRecordService.handleMessage(session)
        }

        // 消息转发（如果启用）
        if (forwardingService) {
          await forwardingService.handleMessage(session)
        }

        // 关键词回复（如果启用）
        if (keywordReplyService) {
          await keywordReplyService.handleMessage(session)
        }

        // OCR 关键词检测（如果启用）
        if (ocrReplyService) {
          await ocrReplyService.handleMessage(session)
        }

        // 报错指引（如果启用）
        if (fileReplyService) {
          await fileReplyService.handleMessage(session)
        }

      } catch (error) {
        ctx.logger.warn('处理 mcl-grouptool 消息事件时发生错误:', error)
      }
    })
  }
}
