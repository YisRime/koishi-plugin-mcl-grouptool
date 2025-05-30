import { Context, Schema } from 'koishi'

export const name = 'mcl-grouptool'

export interface Config {
  preventDuplicate?: boolean
}

export const Config: Schema<Config> = Schema.object({
  preventDuplicate: Schema.boolean().default(true).description('防止重复发送')
})

export function apply(ctx: Context, config: Config) {
  const GROUP_CONFIGS = {
    '666546887': {
      pattern: /minecraft-exported-crash-info-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/i,
      message: '这里是 HMCL 用户群，如果遇到游戏崩溃问题加这个群：666546887'
    },
    '978054335': {
      pattern: /错误报告-\d{4}-\d{1,2}-\d{1,2}_\d{2}\.\d{2}\.\d{2}\.zip$/i,
      message: '本群不解决其他启动器的报错问题，PCL 的游戏崩溃问题加这个群：978054335'
    }
  };
  // 存储待发送的消息队列
  const pendingMessages = new Map<string, { messages: Set<string>, timeout: NodeJS.Timeout }>();
  // 检测文件名并返回匹配的群号
  function detectGroupFromFile(fileName: string): string | null {
    for (const [groupNumber, config] of Object.entries(GROUP_CONFIGS)) if (config.pattern.test(fileName)) return groupNumber;
    return null;
  }
  // 处理延迟发送逻辑
  function handleDelayedSend(channelKey: string, groupNumber: string, session: any) {
    // 清除已有定时器或创建新队列
    if (pendingMessages.has(channelKey)) {
      clearTimeout(pendingMessages.get(channelKey)!.timeout);
    } else {
      pendingMessages.set(channelKey, { messages: new Set(), timeout: null as any });
    }
    const queue = pendingMessages.get(channelKey)!;
    queue.messages.add(groupNumber);
    // 设置3秒延迟发送
    queue.timeout = setTimeout(async () => {
      for (const gNumber of queue.messages) await session.send(GROUP_CONFIGS[gNumber].message);
      pendingMessages.delete(channelKey);
    }, 3000);
  }

  // 监听消息事件
  ctx.on('message', async (session) => {
    // 处理文件检测
    if (session.elements) {
      for (const element of session.elements) {
        if (element.type === 'file') {
          const fileName = element.attrs?.name || element.attrs?.filename || '';
          const groupNumber = detectGroupFromFile(fileName);
          if (groupNumber) {
            if (config.preventDuplicate) {
              handleDelayedSend(session.channelId, groupNumber, session);
            } else {
              await session.send(GROUP_CONFIGS[groupNumber].message);
            }
          }
        }
      }
    }
    // 处理防重复检测
    if (config.preventDuplicate && session.content && pendingMessages.has(session.channelId)) {
      const groupNumbers = pendingMessages.get(session.channelId)!.messages;
      // 检查消息中是否包含群号，如果包含则从待发送队列中移除
      for (const groupNumber of Object.keys(GROUP_CONFIGS)) if (session.content.includes(groupNumber)) groupNumbers.delete(groupNumber);
    }
  });
}
