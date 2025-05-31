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
 * 启动器配置接口
 * @interface LauncherConfig
 * @property {string} groupId - 对应的技术支持群号
 * @property {readonly string[]} groups - 使用该启动器的群号列表
 * @property {RegExp} pattern - 匹配该启动器错误文件名的正则表达式
 */
interface LauncherConfig {
  groupId: string
  groups: readonly string[]
  pattern: RegExp
}

/**
 * 配置信息
 */
const configs = {
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
} as const satisfies Record<string, LauncherConfig>

type Launcher = keyof typeof configs

/**
 * 关键词回复配置接口
 * @interface Keyword
 * @property {string} keyword - 关键词
 * @property {string} reply - 回复内容
 * @property {string} [regex] - 正则表达式（可选）
 */
interface Keyword {
  keyword: string
  reply: string
  regex?: string
}

/**
 * 插件配置接口
 * @interface Config
 * @property {string[]} [whitelist] - 允许使用命令的用户白名单
 * @property {boolean} [preventDup] - 是否防止重复发送
 * @property {boolean} [mention] - 回复时是否@用户
 * @property {boolean} [quote] - 回复时是否引用消息
 * @property {Keyword[]} [keywords] - 关键词回复配置列表
 * @property {boolean} [enableImageForward] - 是否启用图片转发
 * @property {'group' | 'user'} [forwardType] - 图片转发类型
 * @property {string} [forwardTarget] - 图片转发目标ID
 * @property {boolean} [enableOCR] - 是否启用OCR识别
 */
export interface Config {
  whitelist?: string[]
  preventDup?: boolean
  mention?: boolean
  quote?: boolean
  keywords?: Keyword[]
  enableImageForward?: boolean
  forwardType?: 'group' | 'user'
  forwardTarget?: string
  enableOCR?: boolean
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    preventDup: Schema.boolean().default(true).description('延迟发送提示'),
    quote: Schema.boolean().default(true).description('回复时引用消息'),
    mention: Schema.boolean().default(false).description('回复时@用户')
  }).description('自动回复配置'),
  Schema.object({
    whitelist: Schema.array(Schema.string()).description('用户白名单'),
    keywords: Schema.array(Schema.object({
      keyword: Schema.string().description('关键词'),
      reply: Schema.string().description('回复内容'),
      regex: Schema.string().description('正则表达式')
    })).description('关键词配置').role('table')
  }).description('关键词回复配置'),
  Schema.object({
    enableImageForward: Schema.boolean().default(false).description('启用图片转发'),
    forwardType: Schema.union(['group', 'user']).description('转发类型').default('user'),
    forwardTarget: Schema.string().description('转发目标ID'),
    enableOCR: Schema.boolean().default(false).description('启用OCR识别')
  }).description('图片转发配置')
])

/**
 * 待发送消息映射表类型
 * 用于存储延迟发送的消息定时器
 */
type PendingMap = Map<string, NodeJS.Timeout>

/**
 * 插件入口点
 * 初始化插件的命令和事件监听器
 * @param {Context} ctx - Koishi 上下文对象
 * @param {Config} config - 插件配置
 */
export function apply(ctx: Context, config: Config) {
  const pending: PendingMap = new Map()

  /**
   * 解析目标用户ID (支持@元素、@数字格式或纯数字)
   */
  function parseTarget(target: string): string | null {
    if (!target) return null;
    try {
      const at = h.select(h.parse(target), 'at')[0]?.attrs?.id;
      if (at) return at;
    } catch {}
    const m = target.match(/@?(\d{5,10})/);
    return m ? m[1] : null;
  }

  ctx.command('send <keyword> [target]', '发送预设回复')
    .action(async ({ session }, keyword, target) => {
      if (config.whitelist && !config.whitelist.includes(session.userId)) return
      if (!keyword) return '请提供关键词'
      const kw = config.keywords?.find(k => k.keyword === keyword)
      if (!kw) return `未找到关键词 "${keyword}" 的配置`
      const targetUserId = target ? parseTarget(target) : null
      await sendMsg(session, kw.reply, config, targetUserId)
    })

  ctx.on('message', async (session) => {
    const { channelId, elements, content } = session
    const launcher = getLauncher(channelId)
    if (!launcher) return
    if (await handleKeyword(session, content, config.keywords, config)) return
    await handleImageForward(session, elements, config)
    await handleFile(session, elements, launcher, config, pending)
    handleDupCheck(content, channelId, config.preventDup, pending)
  })
}

/**
 * 根据频道ID获取对应的启动器类型
 * @param {string} channelId - 频道ID
 * @returns {Launcher | null} 返回对应的启动器类型，如果未找到则返回null
 */
function getLauncher(channelId: string): Launcher | null {
  for (const [name, config] of Object.entries(configs)) if ((config.groups as readonly string[]).includes(channelId)) return name as Launcher
  return null
}

/**
 * 处理关键词自动回复
 * @param {any} session - 会话对象
 * @param {string | undefined} content - 消息内容
 * @param {Keyword[] | undefined} keywords - 关键词配置数组
 * @param {Config} config - 插件配置
 * @returns {Promise<boolean>} 是否成功匹配并回复了关键词
 */
async function handleKeyword(session: any, content: string | undefined, keywords: Keyword[] | undefined, config: Config): Promise<boolean> {
  if (!content || !keywords) return false
  for (const kw of keywords) {
    if (kw.regex) {
      if (new RegExp(kw.regex, 'i').test(content)) {
        await sendMsg(session, kw.reply, config)
        return true
      }
    }
  }
  return false
}

/**
 * 处理图片转发
 * @param {any} session - 会话对象
 * @param {any[] | undefined} elements - 消息元素数组
 * @param {Config} config - 插件配置
 */
async function handleImageForward(session: any, elements: any[] | undefined, config: Config): Promise<void> {
  if (!config.enableImageForward || !config.forwardTarget || !elements) return

  const imageElement = elements.find(el => el.type === 'img')
  if (!imageElement) return

  const sourceInfo = `${session.author.nickname || session.userId}（${session.guildId || session.channelId}）发送图片：`
  const forwardMsg = h('message', [
    h('text', { content: sourceInfo }),
    h('img', { src: imageElement.attrs.src })
  ])

  try {
    // 转发图片
    if (config.forwardType === 'group') {
      await session.bot.sendMessage(config.forwardTarget, forwardMsg)
    } else {
      await session.bot.sendPrivateMessage(config.forwardTarget, forwardMsg)
    }

    // 进行OCR识别
    if (config.enableOCR) {
      try {
        // 根据API文档，正确的调用方式
        const ocrResult = await session.bot.internal.ocrImage({
          image: imageElement.attrs.src
        })

        // 检查OCR响应格式
        if (ocrResult?.status === 'ok' && ocrResult?.retcode === 0 && ocrResult?.data && Array.isArray(ocrResult.data) && ocrResult.data.length > 0) {
          const extractedTexts = ocrResult.data.map(item => item.text).filter(text => text && text.trim())
          if (extractedTexts.length > 0) {
            const ocrMsg = h('message', [
              h('text', { content: `OCR识别结果：\n${extractedTexts.join('\n')}` })
            ])
            if (config.forwardType === 'group') {
              await session.bot.sendMessage(config.forwardTarget, ocrMsg)
            } else {
              await session.bot.sendPrivateMessage(config.forwardTarget, ocrMsg)
            }
          }
        }
      } catch (ocrError) {
        // OCR失败时静默处理，不影响图片转发功能
        console.warn('OCR识别失败:', ocrError.message || ocrError)
      }
    }
  } catch (error) {
    console.error('图片转发失败:', error.message)
  }
}

/**
 * 处理文件上传事件
 * 当检测到匹配的启动器错误文件时，发送对应的技术支持群引导消息
 * @param {any} session - 会话对象
 * @param {any[] | undefined} elements - 消息元素数组
 * @param {Launcher} launcher - 当前群对应的启动器类型
 * @param {Config} config - 插件配置
 * @param {PendingMap} pending - 待发送消息的映射表
 */
async function handleFile(session: any, elements: any[] | undefined, launcher: Launcher, config: Config, pending: PendingMap) {
  const file = elements?.find(el => el.type === 'file')
  if (!file) return
  const matched = findLauncher(file.attrs.file)
  if (!matched) return
  const isCorrect = matched === launcher
  if (matched === 'bakaxl' && isCorrect) return
  const launcherConfig = configs[matched]
  const msg = buildMsg(isCorrect, matched, launcherConfig.groupId)
  if (config.preventDup) {
    scheduleMsg(session, msg, config, pending)
  } else {
    await sendMsg(session, msg, config)
  }
}

/**
 * 根据文件名查找匹配的启动器
 * @param {string} fileName - 文件名
 * @returns {Launcher | null} 匹配的启动器类型，如果未找到则返回null
 */
function findLauncher(fileName: string): Launcher | null {
  for (const [name, config] of Object.entries(configs)) if (config.pattern.test(fileName)) return name as Launcher
  return null
}

/**
 * 构建回复消息
 * @param {boolean} isCorrect - 是否是正确的启动器群
 * @param {string} launcher - 启动器名称
 * @param {string} groupId - 技术支持群号
 * @returns {string} 构建的回复消息
 */
function buildMsg(isCorrect: boolean, launcher: string, groupId: string): string {
  const prefix = isCorrect ? '这里是' : '本群不解决其他启动器的报错问题，'
  const suffix = isCorrect ? '用户群，如果遇到' : '的'
  return `${prefix} ${launcher.toUpperCase()} ${suffix}游戏崩溃问题加这个群：${groupId}`
}

/**
 * 延迟发送消息
 * @param {any} session - 会话对象
 * @param {string} msg - 要发送的消息
 * @param {Config} config - 插件配置
 * @param {PendingMap} pending - 待发送消息的映射表
 */
function scheduleMsg(session: any, msg: string, config: Config, pending: PendingMap) {
  const { channelId } = session
  const timer = pending.get(channelId)
  if (timer) clearTimeout(timer)
  pending.set(channelId, setTimeout(async () => {
    await sendMsg(session, msg, config)
    pending.delete(channelId)
  }, 3000))
}

/**
 * 处理防重复检查
 * @param {string | undefined} content - 消息内容
 * @param {string} channelId - 频道ID
 * @param {boolean | undefined} preventDup - 是否防止重复发送
 * @param {PendingMap} pending - 待发送消息的映射表
 */
function handleDupCheck(content: string | undefined, channelId: string, preventDup: boolean | undefined, pending: PendingMap) {
  if (!preventDup || !content || !pending.has(channelId)) return
  const shouldCancel = Object.values(configs).some(config => content.includes(config.groupId))
  if (shouldCancel) {
    const timer = pending.get(channelId)!
    clearTimeout(timer)
    pending.delete(channelId)
  }
}

/**
 * 发送消息
 * @param {any} session - 会话对象
 * @param {string} msg - 要发送的消息
 * @param {Config} config - 插件配置
 * @param {string | null} [targetUserId] - 目标用户ID（可选）
 * @returns {Promise<void>}
 */
async function sendMsg(session: any, msg: string, config: Config, targetUserId?: string | null): Promise<void> {
  let elements = []
  if (config.quote && session.messageId) elements.push(h('quote', { id: session.messageId }))
  if (targetUserId) {
    elements.push(h('at', { id: targetUserId }))
    elements.push(h('text', { content: ' ' }))
  } else if (config.mention) {
    elements.push(h('at', { id: session.userId }))
    elements.push(h('text', { content: ' ' }))
  }
  elements.push(h('text', { content: msg }))
  await session.send(elements)
}
