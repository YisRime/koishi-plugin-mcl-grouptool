import { Context, Session } from 'koishi'
import { Config } from '../index'
import { checkKeywords, handleOCR } from '../utils'

export class OcrReplyService {
  constructor(private ctx: Context, private config: Config) {}

  public async handleMessage(session: Session) {
    if (this.config.ocrKeywords?.length) {
      const imageElement = session.elements?.find(el => el.type === 'img')
      if (imageElement) {
        const ocrText = await handleOCR(imageElement, session)
        if (ocrText) {
          await checkKeywords(ocrText, this.config.ocrKeywords, session, this.config)
        }
      }
    }
  }
}
