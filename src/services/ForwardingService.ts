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
