import { join, parse } from 'path'
import { Context, Session } from 'koishi'
import { Config } from '../index'
import { isUserWhitelisted, loadJsonFile, saveJsonFile, fileExists, deleteFile, downloadFile } from '../utils'

// --- 接口与常量定义 ---

// 记录的单条消息结构
interface MessageRecord {
  content: string // 消息内容
  userId: string // 发送者 ID
}

// 消息的目标记录信息
interface TargetInfo {
  recordId: string // 记录文件的 ID (通常是原始文件名)
  uploaderId: string // 上传该文件的用户 ID
}

// 活跃会话信息，用于追踪哪个用户上传的文件正在被讨论
interface ActiveSessionInfo {
  recordId: string // 对应的记录文件 ID
  timestamp: number // 最后一次相关消息的时间戳
}

/**
 * @description 定义了需要持久化存储的完整状态结构。
 */
interface ServiceState {
  fileIndex: Record<string, string> // 文件索引，key: `文件名_文件大小`, value: recordId
  activeFiles: Record<string, Record<string, ActiveSessionInfo>> // 活跃文件会话，key: channelId, value: { key: userId, value: ActiveSessionInfo }
}

// 配置允许记录文件的群组
const FILE_RECORD_GROUPS = ['666546887', '978054335', '958853931'] as const
// 允许记录的文件扩展名
const ALLOWED_EXTENSIONS = ['.zip', '.log', '.txt', '.json', '.gz', '.xz']
// 允许记录的图片扩展名
const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png']
// 当白名单用户可能同时与多人对话时，消息记录添加的前缀
const AMBIGUOUS_MESSAGE_PREFIX = '[交叉对话] '

/**
 * @class FileRecordService
 * @description 核心服务类，负责处理所有与文件记录相关的业务逻辑。
 */
export class FileRecordService {
  private dataDir: string // 存放记录文件和资源的目录
  private stateFilePath: string // 存放服务状态的 state.json 文件路径
  private fileIndex: Record<string, string> = {} // 文件索引
  private activeFiles: Record<string, Record<string, ActiveSessionInfo>> = {} // 活跃会话

  constructor(private ctx: Context, private config: Config, dataPath: string) {
    this.dataDir = join(dataPath, 'logs')
    this.stateFilePath = join(dataPath, 'logs_state.json')
    this.loadState().catch(error => {
      ctx.logger.error('初始化文件记录服务状态失败:', error)
    })
  }

  /**
   * @method handleFile
   * @description 当监听到文件上传时，由此方法处理。
   * @param fileElement 消息中的文件元素
   * @param session 当前会话
   */
  public async handleFile(fileElement: any, session: Session): Promise<void> {
    if (!this.isFileRecordAllowed(session.channelId)) return
    const fileInfo = await this._extractFileInfo(fileElement, session)
    if (!fileInfo) {
      this.ctx.logger.warn('无法从消息元素中获取有效的文件信息。')
      return
    }
    await this._processAndRecordFile(fileInfo.name, fileInfo.size, fileInfo.url, session)
  }

  /**
   * @method handleMessage
   * @description 处理普通消息，判断是否应将其追加到某个文件记录中。
   * @param session 当前会话
   */
  public async handleMessage(session: Session): Promise<void> {
    if (!this.isFileRecordAllowed(session.channelId)) return

    // 查找这条消息应该记录到哪个/哪些文件记录中
    const targets = await this._findTargetRecordInfos(session)
    if (targets.length === 0) return

    // 构建要保存的消息内容（包括下载图片）
    const primaryRecordId = targets[0].recordId
    const builtMessage = await this._buildMessageContent(session, primaryRecordId)
    if (!builtMessage) return // 如果消息无有效内容（如仅为表情），则不记录

    // 如果目标多于一个（交叉对话），则添加前缀
    const finalContent = (targets.length > 1 ? AMBIGUOUS_MESSAGE_PREFIX : '') + builtMessage
    const now = Date.now()
    let stateChanged = false

    // 将消息追加到所有目标记录中，并更新活跃时间
    for (const target of targets) {
      await this._addMessageToRecord(target.recordId, { content: finalContent, userId: session.userId })
      const activeSession = this.activeFiles[session.channelId]?.[target.uploaderId]
      if (activeSession && activeSession.recordId === target.recordId) {
        activeSession.timestamp = now
        stateChanged = true
      }
    }

    if (stateChanged) {
      await this.saveState()
    }
  }

  // --- 私有辅助方法 ---

  private getRecordFilePath = (recordId: string): string => join(this.dataDir, `${recordId}.json`)
  private getAssetFilePath = (fileName: string): string => join(this.dataDir, fileName)

  /**
   * @description 核心逻辑：根据当前消息、发送者身份和会话状态，判断消息应记录到哪个文件。
   */
  private async _findTargetRecordInfos(session: Session): Promise<TargetInfo[]> {
    const { userId: currentUserId, channelId } = session
    const now = Date.now()
    const explicitTargetId = this._getTargetFromReplyOrMention(session) // 检查是否回复或@了某人
    const channelActiveFiles = this.activeFiles[channelId] || {}

    // 场景一：发送者是白名单用户（通常是服主、技术支持）
    if (isUserWhitelisted(currentUserId, this.config)) {
      if (explicitTargetId) {
        // 白名单用户明确回复或@了某人
        const targetInfo = channelActiveFiles[explicitTargetId]
        // 检查目标的会话是否仍在有效期内
        if (targetInfo && now - targetInfo.timestamp <= this.config.conversationTimeout) {
          return [{ recordId: targetInfo.recordId, uploaderId: explicitTargetId }]
        }
        return [] // 目标会话已超时，不记录
      } else {
        // 白名单用户直接发言（未回复或@），可能是在同时回复多个人
        // 记录到所有仍在“活跃讨论期”（recordTimeout）的会话中
        return Object.entries(channelActiveFiles)
          .filter(([_, info]) => now - info.timestamp <= this.config.recordTimeout)
          .map(([uploaderId, info]) => ({ recordId: info.recordId, uploaderId }))
      }
    } else {
      // 场景二：发送者是普通用户
      const uploaderInfo = channelActiveFiles[currentUserId]
      // 检查该用户自己是否有活跃的会话，且未超时
      if (!uploaderInfo || now - uploaderInfo.timestamp > this.config.conversationTimeout) {
        return []
      }
      // 普通用户只能在自己的会话中发言（即没有回复或@别人，或者回复或@的是自己）
      if (!explicitTargetId || explicitTargetId === currentUserId) {
        return [{ recordId: uploaderInfo.recordId, uploaderId: currentUserId }]
      }
    }
    return []
  }

  /**
   * @description 处理并记录一个新上传的文件。
   */
  private async _processAndRecordFile(fileName: string, fileSize: number, fileUrl: string, session: Session): Promise<void> {
    const { userId: uploaderId, channelId } = session
    // 检查文件大小和扩展名
    if (fileSize > 16 * 1024 * 1024 || !this.hasAllowedExtension(fileName)) return

    const fileKey = `${fileName}_${fileSize}`
    const now = Date.now()

    if (!this.activeFiles[channelId]) this.activeFiles[channelId] = {}

    // 如果文件之前已被记录过，则直接更新其活跃状态
    if (this.fileIndex[fileKey] && (await fileExists(this.getRecordFilePath(this.fileIndex[fileKey])))) {
      this.activeFiles[channelId][uploaderId] = { recordId: this.fileIndex[fileKey], timestamp: now }
      await this.saveState()
      return
    }

    // 创建新的文件记录
    const recordId = await this._createNewRecord(fileName, uploaderId)
    this.fileIndex[fileKey] = recordId
    this.activeFiles[channelId][uploaderId] = { recordId, timestamp: now }
    await this.saveState()

    // 后台下载文件，如果失败则回滚记录
    downloadFile(this.ctx, fileUrl, this.getAssetFilePath(recordId)).catch(async error => {
      this.ctx.logger.error(`文件后台下载失败，回滚记录 ${recordId}:`, error)
      await deleteFile(this.getRecordFilePath(recordId))
      if (this.fileIndex[fileKey] === recordId) delete this.fileIndex[fileKey]
      if (this.activeFiles[channelId]?.[uploaderId]?.recordId === recordId) {
        delete this.activeFiles[channelId][uploaderId]
      }
      await this.saveState()
    })
  }

  /**
   * @description 从会话中构建要保存到 JSON 文件里的消息内容，并处理图片。
   */
  private async _buildMessageContent(session: Session, recordId: string | null): Promise<string | null> {
    const contentParts: string[] = []
    let hasMeaningfulContent = false // 标记是否有实质性内容（文本或图片）

    for (const element of session.elements) {
      switch (element.type) {
        case 'text':
          const text = element.attrs.content?.trim()
          if (text) {
            contentParts.push(text)
            hasMeaningfulContent = true
          }
          break
        case 'img':
          // 忽略 QQ 的一些动态表情
          if (element.attrs.summary === '[动画表情]') continue
          const imgName = element.attrs.file || `image_${Date.now()}.jpg`
          if (!this._isAllowedImageExtension(imgName)) continue

          hasMeaningfulContent = true
          // 为图片名添加记录ID前缀以防重名
          const uniqueImgName = recordId ? `${recordId}-${imgName}` : imgName
          try {
            await downloadFile(this.ctx, element.attrs.src, this.getAssetFilePath(uniqueImgName))
            contentParts.push(`[图片: ${uniqueImgName}]`)
          } catch {
            contentParts.push(`[图片下载失败: ${imgName}]`)
          }
          break
      }
    }
    return hasMeaningfulContent ? contentParts.join(' ') : null
  }

  /**
   * @description 创建一个新的 JSON 记录文件。
   */
  private async _createNewRecord(originalFileName: string, uploaderId: string): Promise<string> {
    const { name, ext } = parse(originalFileName)
    let count = 1
    let recordId = originalFileName
    // 处理文件名冲突，例如 a.zip, a(1).zip, a(2).zip
    while (await fileExists(this.getRecordFilePath(recordId))) {
      recordId = `${name}(${count})${ext}`
      count++
    }
    const initialRecord = { recordId, uploaderId, messages: [] as MessageRecord[] }
    await saveJsonFile(this.getRecordFilePath(recordId), initialRecord)
    return recordId
  }

  /**
   * @description 向指定的 JSON 记录文件中追加一条消息。
   */
  private async _addMessageToRecord(recordId: string, message: MessageRecord): Promise<void> {
    const recordPath = this.getRecordFilePath(recordId)
    try {
      const record = await loadJsonFile(recordPath, null)
      if (record) {
        record.messages.push(message)
        await saveJsonFile(recordPath, record)
      }
    } catch (error) {
      this.ctx.logger.error(`无法向记录文件 ${recordId}.json 中添加消息:`, error)
    }
  }

  /**
   * @description 从消息元素或 OneBot API 中提取文件详细信息。
   */
  private async _extractFileInfo(element: any, session: Session): Promise<{ name: string; size: number; url: string } | null> {
    // 优先尝试使用 onebot.getMsg API，因为它通常能提供更可靠的文件信息
    try {
      const msg = await session.onebot.getMsg(session.messageId)
      const fileData = Array.isArray(msg.message) ? msg.message.find(el => el.type === 'file')?.data : null
      if (fileData?.file && fileData.file_size && fileData.url) {
        return { name: fileData.file, size: parseInt(fileData.file_size, 10), url: fileData.url }
      }
    } catch (error) {
      this.ctx.logger.warn('调用 onebot.getMsg API 失败，将回退到使用消息元素属性:', error)
    }
    // API 调用失败或信息不全时，回退到使用消息元素中的 attrs
    const { file, 'file-size': fileSize, src } = element.attrs
    if (file && fileSize && src) {
      return { name: file, size: parseInt(fileSize, 10), url: src }
    }
    return null
  }

  // --- 状态管理 ---

  private async loadState(): Promise<void> {
    const state = await loadJsonFile<ServiceState>(this.stateFilePath, { fileIndex: {}, activeFiles: {} })
    this.fileIndex = state.fileIndex || {}
    this.activeFiles = state.activeFiles || {}
  }

  private async saveState(): Promise<void> {
    const state: ServiceState = {
      fileIndex: this.fileIndex,
      activeFiles: this.activeFiles,
    }
    await saveJsonFile(this.stateFilePath, state)
  }

  // --- 功能开关与判断 ---

  private _getTargetFromReplyOrMention = (session: Session): string | null => session.elements.find(el => el.type === 'at')?.attrs?.id ?? (session.event as any).message?.quote?.user?.id ?? null
  private isFileRecordAllowed = (channelId: string): boolean => [...FILE_RECORD_GROUPS, ...(this.config.additionalGroups || [])].includes(channelId)
  private hasAllowedExtension = (fileName: string): boolean => ALLOWED_EXTENSIONS.some(ext => fileName.toLowerCase().endsWith(ext))
  private _isAllowedImageExtension = (fileName: string): boolean => ALLOWED_IMAGE_EXTENSIONS.some(ext => fileName.toLowerCase().endsWith(ext))
}
