import { Context, Schema } from 'koishi'
import { join } from 'path'
import {} from 'koishi-plugin-adapter-onebot'
import { FileRecordService } from './services/FileRecordService'
import { FileReplyService } from './services/FileReplyService'
import { KeywordReplyService } from './services/KeywordReplyService'
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

export interface Config {
  preventDup?: boolean
  mention?: boolean
  quote?: boolean
  fileReply?: boolean
  keywordReply?: boolean
  ocrReply?: boolean
  enableForward?: boolean
  forwardTarget?: string
  whitelist?: string[]
  fileRecord?: boolean
  additionalGroups?: string[]
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    fileReply: Schema.boolean().default(false).description('启用报错指引'),
    fileRecord: Schema.boolean().default(false).description('启用报告记录'),
    keywordReply: Schema.boolean().default(false).description('启用关键词回复'),
    ocrReply: Schema.boolean().default(false).description('启用 OCR 识别'),
    enableForward: Schema.boolean().default(false).description('启用消息转发'),
  }).description('开关配置'),
  Schema.object({
    preventDup: Schema.boolean().default(true).description('延迟发送提示'),
    quote: Schema.boolean().default(true).description('回复时引用消息'),
    mention: Schema.boolean().default(false).description('回复时@用户'),
    forwardTarget: Schema.string().description('转发目标群'),
    additionalGroups: Schema.array(Schema.string()).description('报告记录群').role('table'),
    whitelist: Schema.array(Schema.string()).description('白名单用户').role('table')
  }).description('通用配置'),
])

export function apply(ctx: Context, config: Config) {
  const dataPath = join(ctx.baseDir, 'data', name)

  // 实例化所有可能用到的服务，并传入数据路径
  const fileReplyService = config.fileReply ? new FileReplyService(ctx, config) : null
  const keywordReplyService = (config.keywordReply || config.ocrReply) ? new KeywordReplyService(ctx, config, dataPath) : null
  const forwardingService = config.enableForward ? new ForwardingService(ctx, config, dataPath) : null
  const fileRecordService = config.fileRecord ? new FileRecordService(ctx, config, dataPath) : null

  // 仅在开启了任何一个功能时才注册消息监听器
  const needsMessageListener = fileReplyService || keywordReplyService || forwardingService || fileRecordService
  if (needsMessageListener) {
    ctx.on('message', async (session) => {
      try {
        // 文件下载和记录（如果启用）
        if (fileRecordService) {
          const file = session.elements?.find(el => el.type === 'file')
          if (file) {
            await fileRecordService.handleFile(file, session)
          }
          await fileRecordService.handleMessage(session)
        }

        // 报错指引（如果启用）
        if (fileReplyService) {
          await fileReplyService.handleMessage(session)
        }

        // 消息转发（如果启用）
        if (forwardingService) {
          await forwardingService.handleMessage(session)
        }

        // 关键词回复（如果启用）
        if (keywordReplyService) {
          await keywordReplyService.handleMessage(session)
        }

      } catch (error) {
        ctx.logger.warn('处理消息时发生错误:', error)
      }
    })
  }
}
