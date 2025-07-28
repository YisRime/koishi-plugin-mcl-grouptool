import { promises as fs } from 'fs'
import { join, parse } from 'path'
import { Context, Session } from 'koishi'
import { Config } from '../index'
import { isUserWhitelisted } from '../utils'

// --- 接口与常量定义 ---
interface MessageRecord {
  content: string;
  userId: string;
  timestamp: number;
}
interface TargetInfo {
  recordId: string;
  uploaderId: string;
}

const FILE_RECORD_GROUPS = ['666546887', '978054335', '958853931'] as const;
const ALLOWED_EXTENSIONS = ['.zip', '.log', '.txt', '.json', '.gz', '.xz'];
const CONVERSATION_TIMEOUT = 5 * 60 * 1000;
const AMBIGUOUS_MESSAGE_PREFIX = '[交叉对话] ';

const DATA_DIR = './data/mcl-grouptool';
const FILE_INDEX_PATH = join(DATA_DIR, 'mcl-file-index.json');
const USER_ACTIVE_FILE_PATH = join('./data', 'mcl-user-active-file.json');

// 文件管理器类，负责所有物理文件的读写操作
class FileManager {
  constructor() {
    this.ensureDataDirectory();
  }

  private async ensureDataDirectory(): Promise<void> {
    try { await fs.access(DATA_DIR); } catch { await fs.mkdir(DATA_DIR, { recursive: true }); }
  }

  async createNewRecord(originalFileName: string, uploaderId: string, channelId: string): Promise<string> {
    const { name, ext } = parse(originalFileName);
    const jsonExt = '.json';
    let count = 1;
    let recordId = originalFileName;

    while (await this.fileExists(`${recordId}${jsonExt}`)) {
      recordId = `${name}(${count})${ext}`;
      count++;
    }

    const recordPath = join(DATA_DIR, `${recordId}${jsonExt}`);
    const initialRecord = { recordId, uploaderId, channelId, uploadTime: new Date().toISOString(), messages: [] as MessageRecord[] };
    await fs.writeFile(recordPath, JSON.stringify(initialRecord, null, 2), 'utf-8');
    return recordId;
  }

  async addMessageToRecord(recordId: string, message: MessageRecord): Promise<void> {
    const recordPath = join(DATA_DIR, `${recordId}.json`);
    try {
      const data = await fs.readFile(recordPath, 'utf-8');
      const record = JSON.parse(data);
      record.messages.push(message);
      await fs.writeFile(recordPath, JSON.stringify(record, null, 2), 'utf-8');
    } catch (error) {
      console.error(`[MCL-GroupTool] 无法向记录 ${recordId}.json 中添加消息:`, error);
    }
  }

  async fileExists(fileNameWithExt: string): Promise<boolean> {
    try { await fs.access(join(DATA_DIR, fileNameWithExt)); return true; } catch { return false; }
  }

  getFilePath(fileName: string): string {
    return join(DATA_DIR, fileName);
  }
}

// --- 核心服务类 ---
export class FileRecordService {
  private fileManager: FileManager;
  private fileIndex: Record<string, string> = {};
  private userActiveFile: Record<string, string> = {};

  private channelConversations = new Map<string, Map<string, number>>();

  constructor(private ctx: Context, private config: Config) {
    this.fileManager = new FileManager();
    this.loadState().catch(error => { ctx.logger.error('无法初始化文件记录服务状态:', error); });
    setInterval(() => this.cleanupStaleConversations(), 1 * 60 * 1000);
  }

  /**
   * 处理上传的文件。
   */
  public async handleFile(fileElement: any, session: Session): Promise<void> {
    if (!this.isFileRecordAllowed(session.channelId)) return;

    let fileName: string;
    let fileSize: number;
    let fileUrl: string;

    try {
      const msg = await session.bot.internal.getMessage(session.channelId, session.messageId);
      const fileData = msg.message?.find(el => el.type === 'file')?.data;
      if (!fileData || !fileData.file || !fileData.file_size) {
        this.ctx.logger.warn(`[MCL-GroupTool] getMessage API did not return valid file data for message ${session.messageId}`);
        return;
      }
      fileName = fileData.file;
      fileSize = parseInt(fileData.file_size, 10);
      fileUrl = fileData.url;
    } catch (error) {
      this.ctx.logger.warn(`[MCL-GroupTool] 调用 getMessage API 失败，将回退到基本属性:`, error);
      fileName = fileElement.attrs.file;
      fileSize = parseInt(fileElement.attrs.file_size || fileElement.attrs['file-size'] || '0', 10);
      fileUrl = fileElement.attrs.src;
    }

    if (!fileName || !fileUrl) {
      this.ctx.logger.warn(`[MCL-GroupTool] 无法从消息元素中获取文件名或URL.`);
      return;
    }

    if (fileSize > 16 * 1024 * 1024 || !this.hasAllowedExtension(fileName)) return;

    const fileKey = `${fileName}_${fileSize}`;
    let recordId = this.fileIndex[fileKey];

    if (recordId && await this.fileManager.fileExists(`${recordId}.json`)) {
      this.ctx.logger.info(`[MCL-GroupTool] 检测到重复文件: ${fileName}.`);
    } else {
      this.ctx.logger.info(`[MCL-GroupTool] 检测到新文件: ${fileName}, 正在创建新记录...`);
      recordId = await this.fileManager.createNewRecord(fileName, session.userId, session.channelId);
      const downloadResult = await this.downloadFile(fileUrl, recordId);
      if (!downloadResult) {
        this.ctx.logger.error(`无法下载文件，记录ID: ${recordId}`);
        return;
      }
      this.fileIndex[fileKey] = recordId;
      await this.saveFileIndex();
    }

    this.userActiveFile[session.userId] = recordId;
    await this.saveUserActiveFile();
  }

  /**
   * 处理聊天消息，进行调度。
   */
  public async handleMessage(session: Session): Promise<void> {
    const targets = this._findTargetRecordInfos(session);
    if (targets.length === 0) return;

    const primaryRecordId = targets[0].recordId;
    const builtMessage = await this._buildMessageContent(session, primaryRecordId);
    if (!builtMessage) return;

    const isAmbiguous = targets.length > 1;
    const finalContent = (isAmbiguous ? AMBIGUOUS_MESSAGE_PREFIX : '') + builtMessage;

    for (const target of targets) {
      await this.fileManager.addMessageToRecord(target.recordId, {
        content: finalContent,
        userId: session.userId,
        timestamp: session.timestamp,
      });
      this.updateConversationTimestamp(session.channelId, target.uploaderId);
    }
  }

  // --- 私有辅助方法 (逻辑实现) ---

  /**
   * 核心逻辑：根据消息上下文查找所有相关的目标档案。
   */
  private _findTargetRecordInfos(session: Session): TargetInfo[] {
    const { userId: currentUserId, channelId } = session;

    // 1. 检查显式上下文 (@优先于回复)
    const explicitTargetId = this._getTargetFromReplyOrMention(session);
    if (explicitTargetId) {
      const recordId = this.userActiveFile[explicitTargetId];
      if (recordId && (isUserWhitelisted(currentUserId, this.config) || currentUserId === explicitTargetId)) {
        return [{ recordId, uploaderId: explicitTargetId }];
      }
    }

    // 2. 检查隐式上下文 (无引用跟进)
    const uploaderRecordId = this.userActiveFile[currentUserId];
    if (uploaderRecordId) {
      return [{ recordId: uploaderRecordId, uploaderId: currentUserId }];
    }

    if (isUserWhitelisted(currentUserId, this.config)) {
      const activeConversations = this._getActiveConversations(channelId);
      if (activeConversations.length > 0) {
        return activeConversations.map(uploaderId => ({
          recordId: this.userActiveFile[uploaderId],
          uploaderId,
        })).filter(target => target.recordId);
      }
    }

    return [];
  }

  /**
   * 核心逻辑：将消息元素构建为最终要记录的字符串，忽略@和引用。
   */
  private async _buildMessageContent(session: Session, recordId: string | null): Promise<string | null> {
    const contentParts: string[] = [];
    let hasMeaningfulContent = false;

    for (const element of session.elements) {
      switch (element.type) {
        case 'text':
          if (element.attrs.content?.trim()) {
            contentParts.push(element.attrs.content);
            hasMeaningfulContent = true;
          }
          break;
        case 'at':
        case 'reply':
          break;
        case 'img':
          // 过滤QQ动画表情
          if (element.attrs.summary === '[动画表情]') continue;

          hasMeaningfulContent = true;
          const originalFileName = element.attrs.file || `image_${Date.now()}.jpg`;
          const uniqueImageName = recordId ? `${recordId}-${originalFileName}` : originalFileName;

          const downloadResult = await this.downloadFile(element.attrs.src, uniqueImageName);
          contentParts.push(downloadResult ? `[图片: ${uniqueImageName}]` : `[图片下载失败: ${originalFileName}]`);
          break;
      }
    }

    return hasMeaningfulContent ? contentParts.join('') : null;
  }

  // --- 私有辅助方法 (状态管理与工具函数) ---

  private updateConversationTimestamp(channelId: string, uploaderId: string): void {
    if (!this.channelConversations.has(channelId)) {
      this.channelConversations.set(channelId, new Map());
    }
    this.channelConversations.get(channelId).set(uploaderId, Date.now());
  }

  private cleanupStaleConversations(): void {
    const now = Date.now();
    for (const [channelId, conversations] of this.channelConversations.entries()) {
      for (const [uploaderId, timestamp] of conversations.entries()) {
        if (now - timestamp >= CONVERSATION_TIMEOUT) {
          conversations.delete(uploaderId);
        }
      }
      if (conversations.size === 0) {
        this.channelConversations.delete(channelId);
      }
    }
  }

  private _getActiveConversations(channelId: string): string[] {
    const conversations = this.channelConversations.get(channelId);
    if (!conversations) return [];
    const now = Date.now();
    return Array.from(conversations.entries())
      .filter(([, timestamp]) => now - timestamp < CONVERSATION_TIMEOUT)
      .map(([uploaderId]) => uploaderId);
  }

  private _getTargetFromReplyOrMention(session: Session): string | null {
    const mention = session.elements?.find(el => el.type === 'at');
    if (mention?.attrs?.id) return mention.attrs.id;

    const quote = (session.event as any).message?.quote;
    if (quote?.user?.id) return quote.user.id;

    return null;
  }

  private isFileRecordAllowed(channelId: string): boolean {
    const baseGroups = FILE_RECORD_GROUPS as readonly string[];
    const additionalGroups = this.config.additionalGroups || [];
    return [...baseGroups, ...additionalGroups].includes(channelId);
  }

  private hasAllowedExtension(fileName: string): boolean {
    if (!fileName.includes('.')) return false;
    const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
    return ALLOWED_EXTENSIONS.includes(ext);
  }

  private async downloadFile(url: string, newFileNameOnDisk: string): Promise<{ path: string, size: number } | null> {
    try {
      const response = await this.ctx.http.get(url, { responseType: 'arraybuffer' });
      const downloadPath = this.fileManager.getFilePath(newFileNameOnDisk);
      await fs.writeFile(downloadPath, Buffer.from(response));
      return { path: downloadPath, size: response.byteLength };
    } catch (error) {
      this.ctx.logger.warn(`[MCL-GroupTool] 文件下载失败: ${newFileNameOnDisk}`, error);
      return null;
    }
  }

  private async loadState(): Promise<void> {
    try { this.fileIndex = JSON.parse(await fs.readFile(FILE_INDEX_PATH, 'utf-8')); } catch { this.fileIndex = {}; }
    try { this.userActiveFile = JSON.parse(await fs.readFile(USER_ACTIVE_FILE_PATH, 'utf-8')); } catch { this.userActiveFile = {}; }
  }
  private async saveFileIndex(): Promise<void> { await fs.writeFile(FILE_INDEX_PATH, JSON.stringify(this.fileIndex, null, 2)); }
  private async saveUserActiveFile(): Promise<void> { await fs.writeFile(USER_ACTIVE_FILE_PATH, JSON.stringify(this.userActiveFile, null, 2)); }
}
