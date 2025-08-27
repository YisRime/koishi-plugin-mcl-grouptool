import { join } from 'path'
import { Context, h, Session } from 'koishi'
import { Config } from '../index'
import { loadJsonFile, saveJsonFile } from '../utils'

// 转发关键词的配置接口
interface FwdKeywordConfig {
  text: string   // 关键词文本
  regex?: string // 可选的正则表达式
}

/**
 * @class ForwardingService
 * @description 负责根据关键词匹配，将消息转发到指定的群组或频道。
 */
export class ForwardingService {
  private fwdKeywords: FwdKeywordConfig[] = []
  private fwdKeywordsFilePath: string // fwd_keywords.json 的路径

  constructor(private ctx: Context, private config: Config, dataPath: string) {
    this.fwdKeywordsFilePath = join(dataPath, 'fwd_keywords.json')
    this.loadFwdKeywords().catch(err => ctx.logger.error('加载转发关键词失败:', err))
  }

  // 从 JSON 文件加载转发关键词列表
  private async loadFwdKeywords(): Promise<void> {
    this.fwdKeywords = await loadJsonFile(this.fwdKeywordsFilePath, [])
  }

  // 保存转发关键词列表到 JSON 文件
  private async saveFwdKeywords(): Promise<void> {
    await saveJsonFile(this.fwdKeywordsFilePath, this.fwdKeywords)
  }

  /**
   * @method listFwdKeywords
   * @description 列出所有已配置的转发关键词。
   * @returns 包含所有关键词的字符串。
   */
  public listFwdKeywords(): string {
    if (!this.fwdKeywords.length) return '当前没有配置转发关键词'
    const keywordList = this.fwdKeywords.map(kw => kw.text).join(' | ')
    return `可用转发关键词列表：\n${keywordList}`
  }

  /**
   * @method addFwdKeyword
   * @description 添加一个新的转发关键词。
   * @param text 要添加的关键词
   * @returns 操作结果的提示信息。
   */
  public async addFwdKeyword(text: string): Promise<string> {
    if (this.fwdKeywords.some(kw => kw.text === text)) {
      return `转发关键词「${text}」已存在`
    }
    this.fwdKeywords.push({ text })
    await this.saveFwdKeywords()
    return `成功添加转发关键词「${text}」`
  }

  /**
   * @method removeFwdKeyword
   * @description 删除一个转发关键词。
   * @param text 要删除的关键词
   * @returns 操作结果的提示信息。
   */
  public async removeFwdKeyword(text: string): Promise<string> {
    const index = this.fwdKeywords.findIndex(kw => kw.text === text)
    if (index === -1) {
      return `未找到转发关键词「${text}」`
    }
    this.fwdKeywords.splice(index, 1)
    await this.saveFwdKeywords()
    return `成功删除转发关键词「${text}」`
  }

  /**
   * @method renameFwdKeyword
   * @description 重命名一个转发关键词。
   * @param oldText 旧关键词
   * @param newText 新关键词
   * @returns 操作结果的提示信息。
   */
  public async renameFwdKeyword(oldText: string, newText: string): Promise<string> {
    if (oldText === newText) return '新旧关键词不能相同'
    const keyword = this.fwdKeywords.find(kw => kw.text === oldText)
    if (!keyword) {
      return `未找到转发关键词「${oldText}」`
    }
    if (this.fwdKeywords.some(kw => kw.text === newText)) {
      return `转发关键词「${newText}」已存在`
    }
    keyword.text = newText
    await this.saveFwdKeywords()
    return `成功重命名转发关键词「${oldText}」为「${newText}」`
  }

  /**
   * @method toggleFwdKeywordRegex
   * @description 为转发关键词配置或移除正则表达式。
   * @param text 目标关键词
   * @param regex 正则表达式字符串，为空则表示移除
   * @returns 操作结果的提示信息。
   */
  public async toggleFwdKeywordRegex(text: string, regex?: string): Promise<string> {
    const keyword = this.fwdKeywords.find(kw => kw.text === text)
    if (!keyword) {
      return `未找到转发关键词「${text}」`
    }

    if (regex) {
      keyword.regex = regex
      await this.saveFwdKeywords()
      return `成功为转发关键词「${text}」设置了正则表达式`
    } else {
      if (!keyword.regex) {
        return `转发关键词「${text}」没有配置正则表达式`
      }
      delete keyword.regex
      await this.saveFwdKeywords()
      return `成功移除了转发关键词「${text}」的正则表达式`
    }
  }

  /**
   * @method handleMessage
   * @description 消息事件的主要处理函数，用于匹配关键词并转发消息。
   * @param session 当前会话
   */
  public async handleMessage(session: Session): Promise<void> {
    // 检查是否配置了转发目标以及是否存在关键词
    if (!this.config.forwardTarget || !this.fwdKeywords?.length) return

    const { content } = session
    if (!content) return

    // 检查消息内容是否匹配任一关键词
    const matchFound = this.fwdKeywords.some(kw => {
      if (kw.regex) {
        // 如果配置了正则，则优先使用正则表达式进行匹配
        return new RegExp(kw.regex, 'i').test(content)
      } else {
        // 否则，使用纯文本包含匹配
        return content.includes(kw.text)
      }
    })

    if (matchFound) {
      // 构建转发消息，在开头添加发送者信息
      const senderInfo = `消息来源: ${session.userId} (群: ${session.guildId || session.channelId})`
      const elements = session.elements.slice(0) // 复制原始消息元素
      elements.unshift(h('text', { content: `${senderInfo}\n` }))
      await session.bot.sendMessage(this.config.forwardTarget, elements)
    }
  }
}
