import { join } from 'path'
import { Context, h, Session } from 'koishi'
import { Config } from '../index'
import { buildReplyElements, isUserWhitelisted, loadJsonFile, saveJsonFile, checkKeywords, handleOCR } from '../utils'

interface KeywordConfig {
  regex: string
  reply: string
}

export class KeywordReplyService {
  private keywords: KeywordConfig[] = []
  private keywordsFilePath: string

  constructor(private ctx: Context, private config: Config, dataPath: string) {
    this.keywordsFilePath = join(dataPath, 'keywords.json')
    this.loadKeywords().catch(err => ctx.logger.error('加载文本关键词失败:', err))
    this.registerCommands()
  }

  private async loadKeywords(): Promise<void> {
    this.keywords = await loadJsonFile(this.keywordsFilePath, [])
  }

  private async saveKeywords(): Promise<void> {
    await saveJsonFile(this.keywordsFilePath, this.keywords)
  }

  private registerCommands(): void {
    this.ctx
      .command('send <regexPattern> [target]', '发送预设回复')
      .option('list', '-l 查看关键词列表')
      .option('reload', '-r 重新加载关键词')
      .action(async ({ session, options }, regexPattern, target) => {
        if (!isUserWhitelisted(session.userId, this.config)) return

        if (options.reload) {
          await this.loadKeywords()
          return '文本关键词列表已重新加载。'
        }

        if (options.list) {
          if (!this.keywords.length) return '当前没有配置任何文本关键词。\n请在 ' + this.keywordsFilePath + ' 文件中配置。'
          const keywordList = this.keywords.map((kw, index) => `${index + 1}. ${kw.regex}`).join('\n')
          return `可用关键词列表：\n${keywordList}\n\n使用方法: send <正则表达式> [目标用户]`
        }

        if (!regexPattern) return '请提供正则表达式。\n使用 send -l 查看可用关键词列表。'

        const kw = this.keywords.find(k => k.regex === regexPattern)
        if (!kw) return `未找到正则表达式 "${regexPattern}" 的配置。\n使用 send -l 查看可用关键词列表。`

        let targetUserId: string | null = null
        if (target) {
          const at = h.select(h.parse(target), 'at')[0]?.attrs?.id
          targetUserId = at || target.match(/@?(\d{5,10})/)?.[1] || null
        }

        try {
          await session.send(buildReplyElements(session, kw.reply, targetUserId, this.config))
          return '' // No-op reply on success
        } catch (error) {
          this.ctx.logger.error('发送预设回复失败:', error)
          return '发送预设回复失败。'
        }
      })
  }

  public async handleMessage(session: Session) {
    if (!this.keywords?.length) return

    const { content, elements } = session
    let replied = false

    // 1. 如果启用了关键词回复，则检查纯文本内容
    if (this.config.keywordReply && content) {
      replied = await checkKeywords(content, this.keywords, session, this.config)
    }

    // 2. 如果启用了OCR回复，则检查图片内容
    if (this.config.ocrReply) {
      const imageElement = elements?.find(el => el.type === 'img')
      if (imageElement) {
        const ocrText = await handleOCR(imageElement, session)
        if (ocrText) {
          await checkKeywords(ocrText, this.keywords, session, this.config)
        }
      }
    }
  }
}
