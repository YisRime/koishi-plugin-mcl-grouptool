import { join } from 'path'
import { Context, h, Session } from 'koishi'
import { Config } from '../index'
import { loadJsonFile, saveJsonFile } from '../utils'

interface FwdKeywordConfig {
  text: string
  regex?: string
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
    const keywordList = this.fwdKeywords.map(kw => kw.text).join(' | ')
    return `转发关键词列表：\n${keywordList}`
  }

  public async addFwdKeyword(text: string): Promise<string> {
    if (this.fwdKeywords.some(kw => kw.text === text)) {
      return `转发关键词 "${text}" 已存在。`
    }
    this.fwdKeywords.push({ text })
    await this.saveFwdKeywords()
    return `成功添加转发关键词 "${text}"。`
  }

  public async removeFwdKeyword(text: string): Promise<string> {
    const index = this.fwdKeywords.findIndex(kw => kw.text === text)
    if (index === -1) {
      return `未找到转发关键词 "${text}"。`
    }
    this.fwdKeywords.splice(index, 1)
    await this.saveFwdKeywords()
    return `成功删除转发关键词 "${text}"。`
  }

  public async renameFwdKeyword(oldText: string, newText: string): Promise<string> {
    if (oldText === newText) return '新旧关键词不能相同。'
    const keyword = this.fwdKeywords.find(kw => kw.text === oldText)
    if (!keyword) {
      return `未找到转发关键词 "${oldText}"。`
    }
    if (this.fwdKeywords.some(kw => kw.text === newText)) {
      return `转发关键词 "${newText}" 已存在。`
    }
    keyword.text = newText
    await this.saveFwdKeywords()
    return `成功重命名转发关键词 "${oldText}" 为 "${newText}"。`
  }

  public async toggleFwdKeywordRegex(text: string, regex?: string): Promise<string> {
    const keyword = this.fwdKeywords.find(kw => kw.text === text)
    if (!keyword) {
      return `未找到转发关键词 "${text}"。`
    }

    if (regex) {
      keyword.regex = regex
      await this.saveFwdKeywords()
      return `成功为转发关键词 "${text}" 设置正则表达式。`
    } else {
      if (!keyword.regex) {
        return `转发关键词 "${text}" 没有配置正则表达式。`
      }
      delete keyword.regex
      await this.saveFwdKeywords()
      return `成功移除了转发关键词 "${text}" 的正则表达式。`
    }
  }

  public async handleMessage(session: Session) {
    if (!this.config.forwardTarget || !this.fwdKeywords?.length) return

    const { content } = session
    if (!content) return

    const matchFound = this.fwdKeywords.some(kw => {
      if (kw.regex) {
        // If regex exists, it's the only thing we test for this keyword
        return new RegExp(kw.regex, 'i').test(content)
      } else {
        // Otherwise, we test for the plain text
        return content.includes(kw.text)
      }
    })

    if (matchFound) {
      const senderInfo = `${session.userId}（${session.guildId || session.channelId}）`
      const elements = session.elements.slice(0) // Create a copy
      elements.unshift(h('text', { content: `${senderInfo}\n` }))
      await session.bot.sendMessage(this.config.forwardTarget, elements)
    }
  }
}
