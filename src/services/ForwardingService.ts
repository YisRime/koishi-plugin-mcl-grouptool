import { Context, Session } from 'koishi'
import { Config } from '../index'
import { handleOCR } from '../utils'

export class ForwardingService {
  constructor(private ctx: Context, private config: Config) {}

  public async handleMessage(session: Session) {
    if (!this.config.forwardTarget) return

    const { elements, content } = session

    // 如果设置了转发关键词，但消息内容不匹配，则不转发
    if (this.config.fwdKeywords?.length && content && !this.config.fwdKeywords.some(kw => kw.regex && new RegExp(kw.regex, 'i').test(content))) {
      return
    }

    const senderInfo = `${session.userId}（${session.guildId || session.channelId}）`
    const imageElement = elements?.find(el => el.type === 'img')

    if (imageElement && this.config.forwardOcr) {
      const ocrText = await handleOCR(imageElement, session)
      if (ocrText) {
        await session.bot.sendMessage(this.config.forwardTarget, `${senderInfo}\n${ocrText}`)
      }
    }

    // 只要有文本内容就转发
    if (content) {
      await session.bot.sendMessage(this.config.forwardTarget, `${senderInfo}\n${content}`)
    }
  }
}
