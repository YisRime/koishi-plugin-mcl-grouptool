import { Context, Schema } from 'koishi'

export const name = 'mcl-grouptool'

export interface Config {
  preventDuplicate?: boolean
  hmclGroups?: string[]
  pclGroups?: string[]
  bakaxlGroups?: string[]
}

export const Config: Schema<Config> = Schema.object({
  preventDuplicate: Schema.boolean().default(true).description('防止重复发送'),
  hmclGroups: Schema.array(Schema.string()).default(['633640264', '203232161', '201034984', '533529045', '744304553', '282845310', '482624681', '991620626', '657677715', '775084843']).description('HMCL群列表'),
  pclGroups: Schema.array(Schema.string()).default(['1028074835']).description('PCL群列表'),
  bakaxlGroups: Schema.array(Schema.string()).default(['480455628', '377521448']).description('BakaXL群列表')
})

export function apply(ctx: Context, config: Config) {
  const patterns = [
    {
      name: 'hmcl',groupId: '666546887', groups: config.hmclGroups,
      pattern: /minecraft-exported-crash-info-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/i
    },
    {
      name: 'pcl',groupId: '978054335', groups: config.pclGroups,
      pattern: /错误报告-\d{4}-\d{1,2}-\d{1,2}_\d{2}\.\d{2}\.\d{2}\.zip$/i
    },
    {
      name: 'bakaxl',groupId: '377521448', groups: config.bakaxlGroups,
      pattern: /BakaXL-ErrorCan-\d{14}\.json$/i
    }
  ];
  const pendingMessages = new Map<string, NodeJS.Timeout>();
  ctx.on('message', async (session) => {
    const { channelId, elements, content } = session;
    const currentGroup = patterns.find(p => p.groups.includes(channelId));
    if (!currentGroup) return;
    // 处理文件上传
    const fileElement = elements?.find(el => el.type === 'file');
    if (fileElement) {
      const matchedPattern = patterns.find(p => p.pattern.test(fileElement.attrs.file));
      if (!matchedPattern) return;
      const isCorrectGroup = matchedPattern.name === currentGroup.name;
      const message = `${isCorrectGroup ? '这里是' : '本群不解决其他启动器的报错问题，'} ${matchedPattern.name.toUpperCase()} ${isCorrectGroup ? '用户群，如果遇到' : '的'}游戏崩溃问题加这个群：${matchedPattern.groupId}`;
      if (config.preventDuplicate) {
        const pending = pendingMessages.get(channelId);
        if (pending) clearTimeout(pending);
        pendingMessages.set(channelId, setTimeout(async () => {
          await session.send(message);
          pendingMessages.delete(channelId);
        }, 3000));
      } else {
        await session.send(message);
      }
    }
    // 防重复检测 - 如果消息包含群号则取消发送
    if (config.preventDuplicate && content && pendingMessages.has(channelId)) {
      const shouldCancel = patterns.some(p => content.includes(p.groupId));
      if (shouldCancel) {
        clearTimeout(pendingMessages.get(channelId)!);
        pendingMessages.delete(channelId);
      }
    }
  });
}
