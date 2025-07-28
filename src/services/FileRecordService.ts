import { promises as fs } from 'fs';
import { join, parse } from 'path';
import { Context, Session } from 'koishi';
import {} from 'koishi-plugin-adapter-onebot';
import { Config } from '../index';
import { isUserWhitelisted } from '../utils';

// --- 接口与常量定义 ---

interface MessageRecord {
  content: string;
  userId: string;
}

interface TargetInfo {
  recordId: string;
  uploaderId: string;
}

interface ActiveSessionInfo {
  recordId: string;
  timestamp: number;
}

/**
 * @description 定义了将要被序列化并存入 state.json 文件的完整状态结构。
 * 用户的活跃会话信息被持久化，以在重启后恢复。
 */
interface ServiceState {
  fileIndex: Record<string, string>;
  activeFiles: Record<string, Record<string, ActiveSessionInfo>>;
}

const FILE_RECORD_GROUPS = ['666546887', '978054335', '958853931'] as const;
const ALLOWED_EXTENSIONS = ['.zip', '.log', '.txt', '.json', '.gz', '.xz'];
const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];
const CONVERSATION_TIMEOUT = 24 * 60 * 60 * 1000;
const AMBIGUOUS_MESSAGE_PREFIX = '[交叉对话] ';
const DATA_DIR = './data/mcl-grouptool';
const STATE_FILE_PATH = join('./data/', 'mcl-grouptool.json');

/**
 * 文件管理器类，负责所有物理文件的读写操作，并实现延迟创建目录。
 */
class FileManager {
  private dataDirExists = false;

  private async ensureDataDirectory(): Promise<void> {
    if (this.dataDirExists) return;
    await fs.mkdir(DATA_DIR, { recursive: true });
    this.dataDirExists = true;
  }

  public async writeFile(filePath: string, data: string | Buffer): Promise<void> {
    await this.ensureDataDirectory();
    await fs.writeFile(filePath, data);
  }

  async createNewRecord(originalFileName: string, uploaderId: string): Promise<string> {
    const { name, ext } = parse(originalFileName);
    let count = 1;
    let recordId = originalFileName;
    while (await this.fileExists(`${recordId}.json`)) {
      recordId = `${name}(${count})${ext}`;
      count++;
    }
    const recordPath = join(DATA_DIR, `${recordId}.json`);
    const initialRecord = { recordId, uploaderId, messages: [] as MessageRecord[] };
    await this.writeFile(recordPath, JSON.stringify(initialRecord, null, 2));
    return recordId;
  }

  async deleteRecordFile(recordId: string): Promise<void> {
    const recordPath = join(DATA_DIR, `${recordId}.json`);
    try {
      await fs.unlink(recordPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`无法删除记录文件 ${recordId}.json:`, error);
      }
    }
  }

  async addMessageToRecord(recordId: string, message: MessageRecord): Promise<void> {
    const recordPath = join(DATA_DIR, `${recordId}.json`);
    try {
      const data = await fs.readFile(recordPath, 'utf-8');
      const record = JSON.parse(data);
      record.messages.push(message);
      await this.writeFile(recordPath, JSON.stringify(record, null, 2));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`无法向记录 ${recordId}.json 中添加消息:`, error);
      }
    }
  }

  async fileExists(fileNameWithExt: string): Promise<boolean> {
    try {
      await fs.access(join(DATA_DIR, fileNameWithExt));
      return true;
    } catch {
      return false;
    }
  }

  getFilePath(fileName: string): string {
    return join(DATA_DIR, fileName);
  }
}

/**
 * 核心服务类，处理所有文件记录的业务逻辑。
 */
export class FileRecordService {
  private fileManager = new FileManager();
  private fileIndex: Record<string, string> = {};
  private activeFiles: Record<string, Record<string, ActiveSessionInfo>> = {};

  constructor(private ctx: Context, private config: Config) {
    this.loadState().catch(error => { ctx.logger.error('初始化状态失败:', error); });
  }

  public async handleFile(fileElement: any, session: Session): Promise<void> {
    if (!this.isFileRecordAllowed(session.channelId)) return;
    const fileInfo = await this._extractFileInfo(fileElement, session);
    if (!fileInfo) {
      this.ctx.logger.warn(`无法从消息元素中获取有效的文件信息。`);
      return;
    }
    await this._processAndRecordFile(fileInfo.name, fileInfo.size, fileInfo.url, session);
  }

  public async handleMessage(session: Session): Promise<void> {
    if (!this.isFileRecordAllowed(session.channelId)) return;
    const targets = await this._findTargetRecordInfos(session);
    if (targets.length === 0) return;
    const primaryRecordId = targets[0].recordId;
    const builtMessage = await this._buildMessageContent(session, primaryRecordId);
    if (!builtMessage) return;
    const finalContent = (targets.length > 1 ? AMBIGUOUS_MESSAGE_PREFIX : '') + builtMessage;
    for (const target of targets) {
      await this.fileManager.addMessageToRecord(target.recordId, { content: finalContent, userId: session.userId });
    }
  }

  private async _findTargetRecordInfos(session: Session): Promise<TargetInfo[]> {
    const { userId: currentUserId, channelId } = session;
    const now = Date.now();
    const isWithinTimeout = (timestamp: number) => now - timestamp <= CONVERSATION_TIMEOUT;
    const explicitTargetId = this._getTargetFromReplyOrMention(session);
    const channelActiveFiles = this.activeFiles[channelId] || {};

    if (isUserWhitelisted(currentUserId, this.config)) {
      if (explicitTargetId) {
        const targetInfo = channelActiveFiles[explicitTargetId];
        if (targetInfo && isWithinTimeout(targetInfo.timestamp)) {
          return [{ recordId: targetInfo.recordId, uploaderId: explicitTargetId }];
        }
        return [];
      } else {
        // 白名单用户发言，查找当前频道所有活跃的会话
        return Object.entries(channelActiveFiles)
          .filter(([_, info]) => isWithinTimeout(info.timestamp))
          .map(([uploaderId, info]) => ({ recordId: info.recordId, uploaderId }));
      }
    } else {
      // 普通用户发言
      const uploaderInfo = channelActiveFiles[currentUserId];
      if (!uploaderInfo || !isWithinTimeout(uploaderInfo.timestamp)) {
        return [];
      }
      // 只能回复自己的记录，如果回复的目标不是自己，则不处理
      if (!explicitTargetId || explicitTargetId === currentUserId) {
        return [{ recordId: uploaderInfo.recordId, uploaderId: currentUserId }];
      }
    }
    return [];
  }

  private async _processAndRecordFile(fileName: string, fileSize: number, fileUrl: string, session: Session): Promise<void> {
    const { userId: uploaderId, channelId } = session;
    if (fileSize > 16 * 1024 * 1024 || !this.hasAllowedExtension(fileName)) return;

    const fileKey = `${fileName}_${fileSize}`;
    const now = Date.now();

    if (!this.activeFiles[channelId]) {
      this.activeFiles[channelId] = {};
    }

    if (this.fileIndex[fileKey] && await this.fileManager.fileExists(`${this.fileIndex[fileKey]}.json`)) {
      this.activeFiles[channelId][uploaderId] = { recordId: this.fileIndex[fileKey], timestamp: now };
      await this.saveState();
      return;
    }

    const recordId = await this.fileManager.createNewRecord(fileName, uploaderId);
    this.fileIndex[fileKey] = recordId;
    this.activeFiles[channelId][uploaderId] = { recordId, timestamp: now };
    await this.saveState();

    this.downloadFile(fileUrl, recordId).catch(async (error) => {
      this.ctx.logger.error(`后台下载失败，回滚记录 ${recordId}:`, error);
      await this.fileManager.deleteRecordFile(recordId);
      if (this.fileIndex[fileKey] === recordId) delete this.fileIndex[fileKey];
      if (this.activeFiles[channelId]?.[uploaderId]?.recordId === recordId) {
        delete this.activeFiles[channelId][uploaderId];
      }
      await this.saveState();
    });
  }

  private async _buildMessageContent(session: Session, recordId: string | null): Promise<string | null> {
    const contentParts: string[] = [];
    let hasMeaningfulContent = false;
    for (const element of session.elements) {
      switch (element.type) {
        case 'text':
          const text = element.attrs.content?.trim();
          if (text) {
            contentParts.push(text);
            hasMeaningfulContent = true;
          }
          break;
        case 'img':
          if (element.attrs.summary === '[动画表情]') continue;
          const imgName = element.attrs.file || `image_${Date.now()}.jpg`;
          if (!this._isAllowedImageExtension(imgName)) continue;
          hasMeaningfulContent = true;
          const uniqueImgName = recordId ? `${recordId}-${imgName}` : imgName;
          try {
            await this.downloadFile(element.attrs.src, uniqueImgName);
            contentParts.push(`[图片: ${uniqueImgName}]`);
          } catch {
            contentParts.push(`[图片下载失败: ${imgName}]`);
          }
          break;
      }
    }
    return hasMeaningfulContent ? contentParts.join(' ') : null;
  }

  private async _extractFileInfo(element: any, session: Session): Promise<{ name: string; size: number; url: string } | null> {
    try {
      const msg = await session.onebot.getMsg(session.messageId);
      const fileData = Array.isArray(msg.message) ? msg.message.find(el => el.type === 'file')?.data : null;
      if (fileData?.file && fileData.file_size && fileData.url) {
        return { name: fileData.file, size: parseInt(fileData.file_size, 10), url: fileData.url };
      }
    } catch (error) {
      this.ctx.logger.warn(`调用 onebot.getMsg 失败:`, error);
    }
    const { file, 'file-size': fileSize, src } = element.attrs;
    if (file && fileSize && src) {
      return { name: file, size: parseInt(fileSize, 10), url: src };
    }
    return null;
  }

  private async loadState(): Promise<void> {
    try {
      const stateData = await fs.readFile(STATE_FILE_PATH, 'utf-8');
      const parsedState: ServiceState = JSON.parse(stateData);
      this.fileIndex = parsedState.fileIndex || {};
      this.activeFiles = parsedState.activeFiles || {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.ctx.logger.warn('读取状态文件失败:', error);
      }
      this.fileIndex = {};
      this.activeFiles = {};
    }
  }

  private async saveState(): Promise<void> {
    try {
      const state: ServiceState = {
        fileIndex: this.fileIndex,
        activeFiles: this.activeFiles,
      };
      await this.fileManager.writeFile(STATE_FILE_PATH, JSON.stringify(state, null, 2));
    } catch (error) {
      this.ctx.logger.error('保存服务状态失败:', error);
    }
  }

  private _getTargetFromReplyOrMention = (session: Session): string | null => session.elements.find(el => el.type === 'at')?.attrs?.id ?? (session.event as any).message?.quote?.user?.id ?? null;
  private isFileRecordAllowed = (channelId: string): boolean => [...FILE_RECORD_GROUPS, ...(this.config.additionalGroups || [])].includes(channelId);
  private hasAllowedExtension = (fileName: string): boolean => ALLOWED_EXTENSIONS.some(ext => fileName.toLowerCase().endsWith(ext));
  private _isAllowedImageExtension = (fileName: string): boolean => ALLOWED_IMAGE_EXTENSIONS.some(ext => fileName.toLowerCase().endsWith(ext));
  private async downloadFile(url: string, newFileNameOnDisk: string): Promise<void> {
    try {
      const response = await this.ctx.http.get<ArrayBuffer>(url, { responseType: 'arraybuffer' });
      await this.fileManager.writeFile(this.fileManager.getFilePath(newFileNameOnDisk), Buffer.from(response));
    } catch (error) {
      this.ctx.logger.warn(`文件下载失败: ${newFileNameOnDisk}`, error);
      throw error;
    }
  }
}
