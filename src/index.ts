import { Context, Schema, Session } from 'koishi'
import { join } from 'path'
import {} from 'koishi-plugin-adapter-onebot'
import { FileRecordService } from './services/FileRecordService'
import { FileReplyService } from './services/FileReplyService'
import { KeywordReplyService } from './services/KeywordReplyService'
import { ForwardingService } from './services/ForwardingService'
import { CurfewService } from './services/CurfewService'
import * as utils from './utils'
import { isUserWhitelisted } from './utils'

export const name = 'mcl-grouptool'

// 插件介绍与使用说明
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

// 插件配置项接口
export interface Config {
  // 功能开关
  fileReply?: boolean
  fileRecord?: boolean
  keywordReply?: boolean
  ocrReply?: boolean
  curfew?: boolean
  enableForward?: boolean
  adminCommands?: boolean
  // 参数配置
  preventDup?: boolean
  quote?: boolean
  mention?: boolean
  recordTimeout?: number
  conversationTimeout?: number
  curfewTime?: string
  forwardTarget?: string
  additionalGroups?: string[]
  whitelist?: { userId: string; nickname?: string }[]
}

// 使用 Schema 定义配置项
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    fileReply: Schema.boolean().default(false).description('报错指引'),
    fileRecord: Schema.boolean().default(false).description('报告记录'),
    keywordReply: Schema.boolean().default(false).description('关键词回复'),
    ocrReply: Schema.boolean().default(false).description('OCR 识别'),
    enableForward: Schema.boolean().default(false).description('关键词转发'),
    adminCommands: Schema.boolean().default(false).description('群组管理'),
    curfew: Schema.boolean().default(false).description('定时宵禁'),
  }).description('开关配置'),

  Schema.object({
    quote: Schema.boolean().default(true).description('回复时引用消息。'),
    mention: Schema.boolean().default(false).description('回复时@用户。'),
    preventDup: Schema.boolean().default(true).description('报错指引延迟发送'),
    recordTimeout: Schema.number().default(2).description('报告交叉记录时长（分钟）'),
    conversationTimeout: Schema.number().default(10).description('报告记录会话时长（分钟）'),
    curfewTime: Schema.string().default('23-7').description('宵禁时间'),
    forwardTarget: Schema.string().description('消息转发目标'),
    additionalGroups: Schema.array(Schema.string()).description('报告记录额外群组').role('table'),
    whitelist: Schema.array(Schema.object({
      userId: Schema.string().description('QQ'),
      nickname: Schema.string().description('昵称'),
    })).description('白名单用户').role('table'),
  }).description('参数配置'),
])

/**
 * @function apply
 * @description Koishi 插件主函数，用于加载和初始化所有服务与命令。
 * @param ctx Koishi 上下文
 * @param config 插件配置
 */
export function apply(ctx: Context, config: Config) {
  const dataPath = join(ctx.baseDir, 'data', name)

  // 根据配置按需实例化各个功能服务
  const fileReplyService = config.fileReply ? new FileReplyService(ctx, config) : null
  const keywordReplyService = config.keywordReply || config.ocrReply ? new KeywordReplyService(ctx, config, dataPath) : null
  const forwardingService = config.enableForward ? new ForwardingService(ctx, config, dataPath) : null
  const fileRecordService = config.fileRecord ? new FileRecordService(ctx, config, dataPath) : null
  const curfewService = config.curfew ? new CurfewService(ctx, config) : null

  const mcl = ctx.command('mcl', 'MCL 群组管理')

  // --- 注册群组管理相关子命令 ---
  if (config.adminCommands) {
    const groupAliases = {
      '666546887': '666546887', H: '666546887', HMCL: '666546887',
      '978054335': '978054335', P: '978054335', PCL: '978054335',
    }

    const resolveGroupId = (groupKey: string, session: Session): string | null => {
      if (groupKey) {
        const key = groupKey.toUpperCase()
        if (groupAliases[key]) return groupAliases[key]
      }
      return session.guildId || null
    }

    const checkPermissions = async (session: Session, groupId: string): Promise<boolean> => {
      try {
        if (!isUserWhitelisted(session.userId, config) || !groupId) return false
        const botInfo = await session.onebot.getGroupMemberInfo(+groupId, +session.selfId)
        return botInfo?.role === 'owner' || botInfo?.role === 'admin'
      } catch {
        return false
      }
    }

    mcl
      .subcommand('.m <target:string> [duration:string] [groupKey:string]', '禁言群成员')
      .usage('禁言或解禁指定成员，默认单位为分钟，支持 d,h,m,s。')
      .action(async ({ session }, target, duration, groupKey) => {
        try {
          const groupId = resolveGroupId(groupKey, session)
          if (!groupId || !(await checkPermissions(session, groupId))) return

          const targetId = utils.parseTarget(target)
          if (!targetId) return

          const banDurationInSeconds = utils.parseDurationToSeconds(duration || '30m', 'm')
          if (banDurationInSeconds < 0) return

          await session.onebot.setGroupBan(+groupId, +targetId, banDurationInSeconds)
        } catch {}
      })

    mcl
      .subcommand('.ma [enable:boolean] [groupKey:string]', '全体禁言')
      .usage('开启或关闭全体禁言。')
      .action(async ({ session }, enable, groupKey) => {
        try {
          const groupId = resolveGroupId(groupKey, session)
          if (!groupId || !(await checkPermissions(session, groupId))) return

          const value = typeof enable === 'boolean' ? enable : true
          await session.onebot.setGroupWholeBan(+groupId, value)
          return `群 ${groupId} 已${value ? '开启' : '关闭'}全体禁言。`
        } catch {}
      })

    mcl
      .subcommand('.kk <target:string> [groupKey:string]', '踢出群成员')
      .usage('踢出成员。')
      .action(async ({ session }, target, groupKey) => {
        try {
          const groupId = resolveGroupId(groupKey, session)
          if (!groupId || !(await checkPermissions(session, groupId))) return

          const targetId = utils.parseTarget(target)
          if (!targetId) return

          await session.onebot.setGroupKick(+groupId, +targetId, false)
          return `已踢出 ${targetId}。`
        } catch {}
      })

    mcl
      .subcommand('.ban <target:string> [groupKey:string]', '封禁群成员')
      .usage('踢出成员并拒绝其再次加群。')
      .action(async ({ session }, target, groupKey) => {
        try {
          const groupId = resolveGroupId(groupKey, session)
          if (!groupId || !(await checkPermissions(session, groupId))) return

          const targetId = utils.parseTarget(target)
          if (!targetId) return

          await session.onebot.setGroupKick(+groupId, +targetId, true)
          return `已封禁 ${targetId}。`
        } catch {}
      })

    mcl
      .subcommand('.del', '撤回消息')
      .usage('回复一条消息以将其撤回。')
      .action(async ({ session }) => {
        try {
          if (!session.guildId || !(await checkPermissions(session, session.guildId))) return

          const messageId = session.quote?.id
          if (!messageId) return

          await session.bot.deleteMessage(session.channelId, messageId)
          await session.bot.deleteMessage(session.channelId, session.messageId)
          return ''
        } catch {}
      })
  }

  // --- 注册关键词回复相关子命令 ---
  if (keywordReplyService) {
    mcl
      .subcommand('.ka <text:string> <reply:text>', '添加回复关键词')
      .usage('添加一个用于触发回复的关键词。')
      .action(async ({ session }, text, reply) => {
        if (!isUserWhitelisted(session.userId, config)) return
        if (!text || !reply) return '请提供关键词和回复内容。'
        return keywordReplyService.addKeyword(text, reply)
      })

    mcl
      .subcommand('.kr <text:string>', '删除回复关键词')
      .usage('删除一个现有的回复关键词。')
      .action(async ({ session }, text) => {
        if (!isUserWhitelisted(session.userId, config)) return
        if (!text) return '请提供要删除的关键词。'
        return keywordReplyService.removeKeyword(text)
      })

    mcl
      .subcommand('.kc <oldText:string> <newText:string>', '重命名回复关键词')
      .usage('重命名一个现有的回复关键词。')
      .action(async ({ session }, oldText, newText) => {
        if (!isUserWhitelisted(session.userId, config)) return
        if (!oldText || !newText) return '请提供旧关键词和新关键词。'
        return keywordReplyService.renameKeyword(oldText, newText)
      })

    mcl
      .subcommand('.kl', '查看回复关键词列表')
      .usage('查看所有已配置的回复关键词。')
      .action(({ session }) => {
        if (!isUserWhitelisted(session.userId, config)) return
        return keywordReplyService.listKeywords()
      })

    mcl
      .subcommand('.kgex <text:string> [regex:text]', '配置关键词正则')
      .usage('为回复关键词配置正则表达式。')
      .action(async ({ session }, text, regex) => {
        if (!isUserWhitelisted(session.userId, config)) return
        if (!text) return '请提供要操作的关键词。'
        return keywordReplyService.toggleKeywordRegex(text, regex)
      })

    mcl
      .subcommand('.s <textKey:string> [target:string] [placeholderValue:text]', '发送预设回复')
      .usage('手动触发预设回复。')
      .action(async ({ session }, textKey, target, placeholderValue) => {
        if (!isUserWhitelisted(session.userId, config)) return
        if (!textKey) return '请提供关键词。'

        let recalled = false
        try {
          await session.bot.deleteMessage(session.channelId, session.messageId)
          recalled = true
        } catch (e) {}

        return keywordReplyService.executeSend(session, textKey, target, placeholderValue, { recalled })
      })
  }

  // --- 注册消息转发相关子命令 ---
  if (forwardingService) {
    mcl
      .subcommand('.fa <text:string>', '添加转发关键词')
      .usage('添加一个用于触发消息转发的关键词。')
      .action(async ({ session }, text) => {
        if (!isUserWhitelisted(session.userId, config)) return
        if (!text) return '请提供要添加的关键词。'
        return forwardingService.addFwdKeyword(text)
      })

    mcl
      .subcommand('.fr <text:string>', '删除转发关键词')
      .usage('删除一个现有的转发关键词。')
      .action(async ({ session }, text) => {
        if (!isUserWhitelisted(session.userId, config)) return
        if (!text) return '请提供要删除的关键词。'
        return forwardingService.removeFwdKeyword(text)
      })

    mcl
      .subcommand('.fc <oldText:string> <newText:string>', '重命名转发关键词')
      .usage('重命名一个现有的转发关键词。')
      .action(async ({ session }, oldText, newText) => {
        if (!isUserWhitelisted(session.userId, config)) return
        if (!oldText || !newText) return '请提供旧关键词和新关键词。'
        return forwardingService.renameFwdKeyword(oldText, newText)
      })

    mcl
      .subcommand('.fl', '查看转发关键词列表')
      .usage('查看所有已配置的转发关键词。')
      .action(({ session }) => {
        if (!isUserWhitelisted(session.userId, config)) return
        return forwardingService.listFwdKeywords()
      })

    mcl
      .subcommand('.fgex <text:string> [regex:text]', '配置转发关键词正则')
      .usage('为转发关键词配置正则表达式。')
      .action(async ({ session }, text, regex) => {
        if (!isUserWhitelisted(session.userId, config)) return
        if (!text) return '请提供要操作的关键词。'
        return forwardingService.toggleFwdKeywordRegex(text, regex)
      })
  }

  // --- 注册事件监听器 ---

  // 只要有任何一个需要监听消息的服务开启，就注册统一的消息监听器
  const needsMessageListener = fileReplyService || keywordReplyService || forwardingService || fileRecordService || curfewService
  if (needsMessageListener) {
    ctx.on('message', async session => {
      try {
        // 宵禁服务
        if (curfewService) {
          curfewService.handleMessage(session)
        }

        // 1. 文件记录服务
        if (fileRecordService) {
          const file = session.elements?.find(el => el.type === 'file')
          if (file) {
            await fileRecordService.handleFile(file, session)
          }
          await fileRecordService.handleMessage(session)
        }
        // 2. 报错指引服务
        if (fileReplyService) {
          await fileReplyService.handleMessage(session)
        }
        // 3. 消息转发服务
        if (forwardingService) {
          await forwardingService.handleMessage(session)
        }
        // 4. 关键词回复服务
        if (keywordReplyService) {
          await keywordReplyService.handleMessage(session)
        }
      } catch (error) {
        ctx.logger.warn('处理消息时发生未知错误:', error)
      }
    })
  }
}
