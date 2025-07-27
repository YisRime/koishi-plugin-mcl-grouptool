import { Context, Session } from 'koishi'
import { Config } from '../index'
import { checkKeywords } from '../utils'

export class KeywordReplyService {
  constructor(private ctx: Context, private config: Config) {}

  public async handleMessage(session: Session) {
    const { content } = session
    if (content && this.config.keywords?.length) {
      await checkKeywords(content, this.config.keywords, session, this.config)
    }
  }
}
