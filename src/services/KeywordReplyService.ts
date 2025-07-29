import { join, parse } from 'path'
import { promises as fs } from 'fs'
import { Context, h, Session } from 'koishi'
import { Config } from '../index'
import { buildReplyElements, isUserWhitelisted, loadJsonFile, saveJsonFile, checkKeywords, handleOCR, getTargetUserId, deleteFile, downloadFile, fileExists } from '../utils'

interface KeywordConfig {
  text: string
  reply: string
  regex?: string
  imageIndex: number
}

export class KeywordReplyService {
  private keywords: KeywordConfig[] = []
  private keywordsFilePath: string
  private keywordImagesPath: string

  constructor(private ctx: Context, private config: Config, dataPath: string) {
    this.keywordsFilePath = join(dataPath, 'keywords.json')
    this.keywordImagesPath = join(dataPath, 'keyword_images')
    this.loadKeywords().catch(err => ctx.logger.error('加载文本关键词失败:', err))
  }

  private async loadKeywords(): Promise<void> {
    this.keywords = await loadJsonFile(this.keywordsFilePath, [])
  }

  private async saveKeywords(): Promise<void> {
    await saveJsonFile(this.keywordsFilePath, this.keywords)
  }

  private async processReply(rawReply: string, keywordConfig: KeywordConfig): Promise<string> {
    const elements = h.parse(rawReply)
    const processedElements = await Promise.all(
      elements.map(async el => {
        if (el.type === 'img' && el.attrs.src?.startsWith('http')) {
          const url = el.attrs.src
          try {
            keywordConfig.imageIndex++
            const extension = parse(new URL(url).pathname).ext || '.jpg'
            const fileName = `${keywordConfig.text}_${keywordConfig.imageIndex}${extension}`
            const filePath = join(this.keywordImagesPath, fileName)
            await downloadFile(this.ctx, url, filePath)
            el.attrs.src = `file://${filePath}`
          } catch (error) {
            this.ctx.logger.warn(`图片下载失败: ${url}`, error)
          }
        }
        return el
      }),
    )
    return h.normalize(processedElements).join('')
  }

  public async executeSend(session: Session, textKey: string, target?: string, placeholderValue?: string): Promise<string> {
    const kw = this.keywords.find(k => k.text === textKey)
    if (!kw) return `未找到关键词 "${textKey}" 的配置。`

    const targetUserId = getTargetUserId(target)
    let replyString = kw.reply

    if (placeholderValue) {
      replyString = replyString.replace(/{placeholder}/g, placeholderValue)
    }

    try {
      const replyContent = h.parse(replyString)
      const finalElements = buildReplyElements(session, '', targetUserId, this.config)
      // Remove the empty text element placeholder before adding the real content
      finalElements.pop()
      finalElements.push(...replyContent)

      await session.send(finalElements)
      return '' // No-op reply on success
    } catch (error) {
      this.ctx.logger.error('发送预设回复失败:', error)
    }
  }

  public listKeywords(): string {
    if (!this.keywords.length) return '当前没有配置任何回复关键词。'
    const keywordList = this.keywords.map(kw => kw.text).join(' | ')
    return `可用关键词列表：\n${keywordList}`
  }

  public async addKeyword(text: string, reply: string): Promise<string> {
    if (this.keywords.some(kw => kw.text === text)) {
      return `关键词 "${text}" 已存在。`
    }
    const newKeyword: KeywordConfig = { text, reply: '', imageIndex: 0 }
    const processedReply = await this.processReply(reply, newKeyword)
    newKeyword.reply = processedReply
    this.keywords.push(newKeyword)
    await this.saveKeywords()
    return `成功添加关键词 "${text}"。`
  }

  public async removeKeyword(text: string): Promise<string> {
    const index = this.keywords.findIndex(kw => kw.text === text)
    if (index === -1) {
      return `未找到关键词 "${text}"。`
    }

    const [removed] = this.keywords.splice(index, 1)
    await this.saveKeywords()

    // Delete associated images
    const elements = h.parse(removed.reply)
    for (const el of elements) {
      if (el.type === 'img' && el.attrs.src?.startsWith('file://')) {
        const filePath = el.attrs.src.substring('file://'.length)
        if (await fileExists(filePath)) {
          await deleteFile(filePath)
        }
      }
    }

    return `成功删除关键词 "${text}"。`
  }

  public async renameKeyword(oldText: string, newText: string): Promise<string> {
    if (oldText === newText) return '新旧关键词不能相同。'
    const keyword = this.keywords.find(kw => kw.text === oldText)
    if (!keyword) {
      return `未找到关键词 "${oldText}"。`
    }
    if (this.keywords.some(kw => kw.text === newText)) {
      return `关键词 "${newText}" 已存在。`
    }

    const elements = h.parse(keyword.reply)
    let hasError = false

    for (const el of elements) {
      if (el.type === 'img' && el.attrs.src?.startsWith('file://')) {
        const oldPath = el.attrs.src.substring('file://'.length)
        const oldFileName = parse(oldPath).base
        const newFileName = oldFileName.replace(oldText, newText)
        const newPath = join(this.keywordImagesPath, newFileName)

        try {
          if (await fileExists(oldPath)) {
            await fs.rename(oldPath, newPath)
            el.attrs.src = `file://${newPath}`
          }
        } catch (error) {
          this.ctx.logger.error(`重命名图片文件失败: ${oldPath} -> ${newPath}`, error)
          hasError = true
        }
      }
    }

    keyword.text = newText
    keyword.reply = h.normalize(elements).join('')
    await this.saveKeywords()

    if (hasError) {
      return `成功重命名关键词 "${oldText}" 为 "${newText}"，但部分图片资源重命名失败，请检查日志。`
    }
    return `成功重命名关键词 "${oldText}" 为 "${newText}"。`
  }

  public async toggleKeywordRegex(text: string, regex?: string): Promise<string> {
    const keyword = this.keywords.find(kw => kw.text === text)
    if (!keyword) {
      return `未找到关键词 "${text}"。`
    }

    if (regex) {
      keyword.regex = regex
      await this.saveKeywords()
      return `成功为关键词 "${text}" 设置正则表达式。`
    } else {
      if (!keyword.regex) {
        return `关键词 "${text}" 没有配置正则表达式。`
      }
      delete keyword.regex
      await this.saveKeywords()
      return `成功移除了关键词 "${text}" 的正则表达式。`
    }
  }

  public async handleMessage(session: Session) {
    if (!this.keywords?.length) return

    const { content, elements } = session
    let replied = false

    // 1. 如果启用了关键词回复，则检查纯文本内容
    if (this.config.keywordReply && content) {
      replied = await checkKeywords(content, this.keywords, session, this.config)
    }

    // 2. 如果启用了OCR回复，并且文本内容没有匹配，则检查图片内容
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
