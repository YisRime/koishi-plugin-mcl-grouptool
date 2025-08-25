import { join, parse } from 'path'
import { Context, h, Session } from 'koishi'
import { Config } from '../index'
import { buildReplyElements, loadJsonFile, saveJsonFile, checkKeywords, handleOCR, getTargetUserId } from '../utils'

// 关键词配置的接口定义
interface KeywordConfig {
  text: string       // 关键词文本
  reply: string      // 回复内容（可能包含 h 元素字符串）
  regex?: string     // 可选的正则表达式
}

/**
 * @class KeywordReplyService
 * @description 负责处理关键词自动回复，包括文本和图片内容。
 */
export class KeywordReplyService {
  private keywords: KeywordConfig[] = []
  private keywordsFilePath: string // keywords.json 的路径

  constructor(private ctx: Context, private config: Config, dataPath: string) {
    this.keywordsFilePath = join(dataPath, 'keywords.json')
    this.loadKeywords().catch(err => ctx.logger.error('加载文本关键词失败:', err))
  }

  // 从 JSON 文件加载关键词列表到内存
  private async loadKeywords(): Promise<void> {
    this.keywords = await loadJsonFile(this.keywordsFilePath, [])
  }

  // 将内存中的关键词列表保存到 JSON 文件
  private async saveKeywords(): Promise<void> {
    await saveJsonFile(this.keywordsFilePath, this.keywords)
  }

  /**
   * @method processReply
   * @description 处理原始回复内容，如果包含网络图片，则下载并将其转换为 Base64 编码的 data URI。
   * @param rawReply 原始的回复字符串
   * @returns 处理后的回复字符串
   */
  private async processReply(rawReply: string): Promise<string> {
    const elements = h.parse(rawReply)
    const processedElements = await Promise.all(
      elements.map(async el => {
        if (el.type === 'img' && el.attrs.src?.startsWith('http')) {
          const url = el.attrs.src
          try {
            // 下载图片到内存缓冲区
            const response = await this.ctx.http.get<ArrayBuffer>(url, { responseType: 'arraybuffer' })
            const buffer = Buffer.from(response)
            const base64 = buffer.toString('base64')

            // 从 URL 中推断 MIME 类型，提供默认值
            let mimeType = 'image/jpeg'
            const extension = parse(new URL(url).pathname).ext.toLowerCase()
            if (extension === '.png') mimeType = 'image/png'
            else if (extension === '.gif') mimeType = 'image/gif'
            else if (extension === '.webp') mimeType = 'image/webp'

            // 将 src 替换为 Base64 data URI
            el.attrs.src = `data:${mimeType};base64,${base64}`
          } catch (error) {
            this.ctx.logger.warn(`关键词回复的图片下载并转换为Base64失败: ${url}`, error)
          }
        }
        return el
      }),
    )
    return h.normalize(processedElements).join('')
  }

  /**
   * @method executeSend
   * @description 手动执行发送预设回复的操作。
   * @param session 当前会话
   * @param textKey 要触发的关键词
   * @param target 目标用户ID或@某人
   * @param placeholderValue 用于替换占位符的值
   * @param options 额外选项，例如 { recalled: boolean } 表示指令是否被成功撤回
   * @returns 成功则返回空字符串，失败则返回错误信息。
   */
  public async executeSend(
    session: Session,
    textKey: string,
    target?: string,
    placeholderValue?: string,
    options: { recalled?: boolean } = {},
  ): Promise<string> {
    const kw = this.keywords.find(k => k.text === textKey)
    if (!kw) return `未找到关键词「${textKey}」的配置。`

    const targetUserId = getTargetUserId(target)
    let replyString = kw.reply

    // 替换回复内容中的占位符
    if (placeholderValue) {
      replyString = replyString.replace(/{placeholder}/g, placeholderValue)
    }

    try {
      const replyContent = h.parse(replyString)
      // 先构建基础的回复元素（如引用、@等）
      const finalElements = buildReplyElements(session, '', targetUserId, this.config)
      finalElements.pop() // 移除 buildReplyElements 产生的空文本占位符
      finalElements.push(...replyContent) // 添加真正的回复内容

      // 如果指令被成功撤回，则在回复末尾附加上调用者信息
      if (options.recalled) {
        finalElements.push(h('text', { content: '\n调用者：' }), h('at', { id: session.userId }))
      }

      await session.send(finalElements)
      return '' // 执行成功，返回空字符串
    } catch (error) {
      this.ctx.logger.error('发送预设回复时发生错误:', error)
      return '发送预设回复时发生内部错误，请检查控制台日志。'
    }
  }

  /**
   * @method listKeywords
   * @description 列出所有已配置的关键词。
   * @returns 包含所有关键词的字符串。
   */
  public listKeywords(): string {
    if (!this.keywords.length) return '当前没有配置任何回复关键词。'
    const keywordList = this.keywords.map(kw => kw.text).join(' | ')
    return `可用关键词列表：\n${keywordList}`
  }

  /**
   * @method addKeyword
   * @description 添加一个新的关键词及其回复。
   * @param text 关键词
   * @param reply 回复内容
   * @returns 操作结果的提示信息。
   */
  public async addKeyword(text: string, reply: string): Promise<string> {
    if (this.keywords.some(kw => kw.text === text)) {
      return `关键词「${text}」已存在。`
    }
    const newKeyword: KeywordConfig = { text, reply: '' }
    // 处理回复中的图片
    const processedReply = await this.processReply(reply)
    newKeyword.reply = processedReply
    this.keywords.push(newKeyword)
    await this.saveKeywords()
    return `成功添加关键词「${text}」。`
  }

  /**
   * @method removeKeyword
   * @description 删除一个关键词。
   * @param text 要删除的关键词
   * @returns 操作结果的提示信息。
   */
  public async removeKeyword(text: string): Promise<string> {
    const index = this.keywords.findIndex(kw => kw.text === text)
    if (index === -1) {
      return `未找到关键词「${text}」。`
    }

    this.keywords.splice(index, 1)
    await this.saveKeywords()

    return `成功删除关键词「${text}」。`
  }

  /**
   * @method renameKeyword
   * @description 重命名一个关键词。
   * @param oldText 旧关键词
   * @param newText 新关键词
   * @returns 操作结果的提示信息。
   */
  public async renameKeyword(oldText: string, newText: string): Promise<string> {
    if (oldText === newText) return '新旧关键词不能相同。'
    const keyword = this.keywords.find(kw => kw.text === oldText)
    if (!keyword) {
      return `未找到关键词「${oldText}」。`
    }
    if (this.keywords.some(kw => kw.text === newText)) {
      return `关键词「${newText}」已存在。`
    }

    keyword.text = newText
    await this.saveKeywords()

    return `成功重命名关键词「${oldText}」为「${newText}」。`
  }

  /**
   * @method toggleKeywordRegex
   * @description 为关键词添加或移除正则表达式。
   * @param text 目标关键词
   * @param regex 正则表达式字符串，如果为空则表示移除
   * @returns 操作结果的提示信息。
   */
  public async toggleKeywordRegex(text: string, regex?: string): Promise<string> {
    const keyword = this.keywords.find(kw => kw.text === text)
    if (!keyword) return `未找到关键词「${text}」。`

    if (regex) {
      keyword.regex = regex
      await this.saveKeywords()
      return `成功为关键词「${text}」设置了正则表达式。`
    } else {
      if (!keyword.regex) return `关键词「${text}」没有配置正则表达式。`
      delete keyword.regex
      await this.saveKeywords()
      return `成功移除了关键词「${text}」的正则表达式。`
    }
  }

  /**
   * @method handleMessage
   * @description 消息事件的主要处理函数，用于匹配关键词并发送回复。
   * @param session 当前会话
   */
  public async handleMessage(session: Session): Promise<void> {
    if (!this.keywords?.length) return

    const { content, elements } = session
    let replied = false

    // 1. 如果启用了关键词回复，则检查纯文本内容
    if (this.config.keywordReply && content) {
      replied = await checkKeywords(content, this.keywords, session, this.config)
    }

    // 2. 如果启用了 OCR 回复，并且文本内容没有匹配成功，则检查图片内容
    if (this.config.ocrReply && !replied) {
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
