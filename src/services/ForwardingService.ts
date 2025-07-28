import { join } from 'path'
import { Context, Session } from 'koishi'
import { Config } from '../index'
import { loadJsonFile, saveJsonFile } from '../utils'

interface FwdKeywordConfig {
  regex: string
}

export class ForwardingService {
  private fwdKeywords: FwdKeywordConfig[] = []
  private fwdKeywordsFilePath: string

  constructor(private ctx: Context, private config: Config, dataPath: string) {
    this.fwdKeywordsFilePath = join(dataPath, 'fwd_keywords.json')
    this.loadFwdKeywords().catch(err => ctx.logger.error('加载转发关键词失败:', err))
  }

  private async loadFwdKeywords(): Promise<void> {
    this.fwdKeywords = await loadJsonFile(this.fwdKeywordsFilePath, [])
  }

  private async saveFwdKeywords(): Promise<void> {
    await saveJsonFile(this.fwdKeywordsFilePath, this.fwdKeywords)
  }

  public listFwdKeywords(): string {
    if (!this.fwdKeywords.length) return '当前没有配置任何转发关键词。'
    const keywordList = this.fwdKeywords.map((kw, index) => `${index + 1}. ${kw.regex}`).join('\n')
    return `转发关键词列表：\n${keywordList}`
  }

  public async addFwdKeyword(regex: string): Promise<string> {
    if (this.fwdKeywords.some(kw => kw.regex === regex)) {
      return `转发关键词 "${regex}" 已存在。`
    }
    this.fwdKeywords.push({ regex })
    await this.saveFwdKeywords()
    return `成功添加转发关键词 "${regex}"。`
  }

  public async removeFwdKeyword(regex: string): Promise<string> {
    const index = this.fwdKeywords.findIndex(kw => kw.regex === regex)
    if (index === -1) {
      return `未找到转发关键词 "${regex}"。`
    }
    this.fwdKeywords.splice(index, 1)
    await this.saveFwdKeywords()
    return `成功删除转发关键词 "${regex}"。`
  }

  public async handleMessage(session: Session) {
    if (!this.config.forwardTarget) return

    const { content } = session

    if (this.fwdKeywords?.length && content && !this.fwdKeywords.some(kw => kw.regex && new RegExp(kw.regex, 'i').test(content))) {
      return
    }

    const senderInfo = `${session.userId}（${session.guildId || session.channelId}）`

    if (content) {
      await session.bot.sendMessage(this.config.forwardTarget, `${senderInfo}\n${content}`)
    }
  }
}
