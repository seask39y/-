// 房间存储层 —— 双后端：
//  - 内存版：本地开发 / Kimi 平台预览（单进程常驻），零依赖
//  - Redis 版（Upstash REST）：Vercel Serverless 部署，请求间共享状态
// 通过环境变量 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 自动切换。

export interface ChatMessage {
  id: number;
  kind: "msg" | "system";
  memberId: string | null;
  nickname: string;
  text: string;
  ts: number;
}

export interface MemberInfo {
  nickname: string;
  isCreator: boolean;
}

export interface JoinResult {
  code: string;
  token: string;
  memberId: string;
}

export type StateResult =
  | {
      status: "ok";
      code: string;
      me: { id: string; nickname: string; isCreator: boolean } | null;
      members: MemberInfo[];
      messages: ChatMessage[];
      latestId: number;
    }
  | { status: "closed"; code: string }
  | { status: "gone" };

export type SendResult = "ok" | "not_member" | "closed" | "gone";
export type BurnResult = "ok" | "forbidden" | "not_member" | "gone";

export interface Store {
  create(nickname: string): Promise<JoinResult>;
  join(code: string, nickname: string): Promise<JoinResult | null>;
  state(code: string, token: string, sinceId: number): Promise<StateResult>;
  send(code: string, token: string, text: string): Promise<SendResult>;
  leave(code: string, token: string): Promise<void>;
  burn(code: string, token: string): Promise<BurnResult>;
}

const MAX_MESSAGES = 500;

function randomToken(): string {
  return (
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2) +
    Date.now().toString(36)
  );
}

function sixDigits(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* ────────────────────────── 内存版 ────────────────────────── */

function createMemoryStore(): Store {
  interface Member {
    id: string;
    token: string;
    nickname: string;
    isCreator: boolean;
    lastSeen: number;
  }
  interface Room {
    code: string;
    createdAt: number;
    seq: number;
    messages: ChatMessage[];
    members: Map<string, Member>;
    closed: boolean;
    closedAt: number | null;
  }

  const rooms = new Map<string, Room>();
  const MEMBER_TIMEOUT_MS = 30_000;
  const ROOM_IDLE_BURN_MS = 5 * 60_000;
  const BURNED_KEEP_MS = 60_000;

  function sys(room: Room, text: string) {
    room.messages.push({ id: ++room.seq, kind: "system", memberId: null, nickname: "", text, ts: Date.now() });
    if (room.messages.length > MAX_MESSAGES) {
      room.messages.splice(0, room.messages.length - MAX_MESSAGES);
    }
  }

  function transferOwnership(room: Room) {
    const next = room.members.values().next().value as Member | undefined;
    if (next && !room.closed) {
      next.isCreator = true;
      sys(room, `${next.nickname} 成为房主`);
    }
  }

  function sweep() {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.closed && room.closedAt && now - room.closedAt > BURNED_KEEP_MS) {
        rooms.delete(code);
        continue;
      }
      let creatorLeft = false;
      for (const [id, m] of room.members) {
        if (now - m.lastSeen > MEMBER_TIMEOUT_MS) {
          room.members.delete(id);
          if (m.isCreator) creatorLeft = true;
          if (!room.closed) sys(room, `${m.nickname} 离开了房间`);
        }
      }
      if (creatorLeft) transferOwnership(room);
      if (!room.closed && room.members.size === 0 && now - room.createdAt > ROOM_IDLE_BURN_MS) {
        rooms.delete(code);
      }
    }
  }
  setInterval(sweep, 15_000).unref?.();

  return {
    async create(nickname) {
      sweep();
      let code = sixDigits();
      for (let i = 0; rooms.has(code) && i < 100; i++) code = sixDigits();
      const token = randomToken();
      const member: Member = { id: token, token, nickname, isCreator: true, lastSeen: Date.now() };
      const room: Room = {
        code,
        createdAt: Date.now(),
        seq: 0,
        messages: [],
        members: new Map([[member.id, member]]),
        closed: false,
        closedAt: null,
      };
      rooms.set(code, room);
      sys(room, `${nickname} 创建了房间，聊天内容将在关闭后焚毁`);
      return { code, token, memberId: member.id };
    },

    async join(code, nickname) {
      const room = rooms.get(code);
      if (!room || room.closed) return null;
      const token = randomToken();
      room.members.set(token, { id: token, token, nickname, isCreator: false, lastSeen: Date.now() });
      sys(room, `${nickname} 加入了房间`);
      return { code: room.code, token, memberId: token };
    },

    async state(code, token, sinceId) {
      const room = rooms.get(code);
      if (!room) return { status: "gone" };
      if (room.closed) return { status: "closed", code: room.code };
      const now = Date.now();
      const me = room.members.get(token) ?? null;
      if (me) me.lastSeen = now;
      return {
        status: "ok",
        code: room.code,
        me: me ? { id: me.id, nickname: me.nickname, isCreator: me.isCreator } : null,
        members: [...room.members.values()]
          .filter((m) => now - m.lastSeen <= MEMBER_TIMEOUT_MS)
          .map((m) => ({ nickname: m.nickname, isCreator: m.isCreator })),
        messages: room.messages.filter((m) => m.id > sinceId),
        latestId: room.seq,
      };
    },

    async send(code, token, text) {
      const room = rooms.get(code);
      if (!room) return "gone";
      if (room.closed) return "closed";
      const me = room.members.get(token);
      if (!me) return "not_member";
      me.lastSeen = Date.now();
      room.messages.push({ id: ++room.seq, kind: "msg", memberId: me.id, nickname: me.nickname, text, ts: Date.now() });
      if (room.messages.length > MAX_MESSAGES) {
        room.messages.splice(0, room.messages.length - MAX_MESSAGES);
      }
      return "ok";
    },

    async leave(code, token) {
      const room = rooms.get(code);
      if (!room) return;
      const me = room.members.get(token);
      if (!me) return;
      room.members.delete(token);
      if (!room.closed) {
        sys(room, `${me.nickname} 离开了房间`);
        if (me.isCreator) transferOwnership(room);
      }
    },

    async burn(code, token) {
      const room = rooms.get(code);
      if (!room) return "gone";
      const me = room.members.get(token);
      if (!me) return "not_member";
      if (!me.isCreator) return "forbidden";
      room.closed = true;
      room.closedAt = Date.now();
      room.members.clear();
      return "ok";
    },
  };
}

/* ─────────────────────── Redis 版（Upstash REST） ─────────────────────── */

interface RoomMeta {
  createdAt: number;
  closed: boolean;
  closedAt: number | null;
  members: { id: string; token: string; nickname: string; isCreator: boolean }[];
}

function createRedisStore(url: string, authToken: string): Store {
  const ROOM_TTL = 7200; // 房间 2 小时无活动自动焚毁（写入时滑动续期）
  const PRESENCE_TTL = 45; // 在线心跳 key，轮询时滑动续期
  const BURNED_TTL = 60; // 焚毁后保留"已焚毁"状态 60 秒

  const kMeta = (c: string) => `r:${c}`;
  const kMsgs = (c: string) => `r:${c}:msgs`;
  const kSeq = (c: string) => `r:${c}:seq`;
  const kP = (c: string, t: string) => `r:${c}:p:${t}`;

  async function cmd(args: (string | number)[]): Promise<unknown> {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(args.map(String)),
    });
    const j = (await res.json()) as { result?: unknown; error?: string };
    if (j.error) throw new Error(`redis: ${j.error}`);
    return j.result;
  }

  async function pipe(cmds: (string | number)[][]): Promise<unknown[]> {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds.map((c) => c.map(String))),
    });
    const j = (await res.json()) as { result?: unknown; error?: string }[];
    return j.map((r) => {
      if (r.error) throw new Error(`redis: ${r.error}`);
      return r.result;
    });
  }

  async function getMeta(code: string): Promise<RoomMeta | null> {
    const raw = await cmd(["GET", kMeta(code)]);
    return typeof raw === "string" ? (JSON.parse(raw) as RoomMeta) : null;
  }

  async function nextId(code: string): Promise<number> {
    return Number(await cmd(["INCR", kSeq(code)]));
  }

  async function pushMsg(code: string, msg: ChatMessage) {
    await pipe([
      ["RPUSH", kMsgs(code), JSON.stringify(msg)],
      ["LTRIM", kMsgs(code), -MAX_MESSAGES, -1],
      ["EXPIRE", kMsgs(code), ROOM_TTL],
    ]);
  }

  async function roomExists(code: string): Promise<boolean> {
    return Number(await cmd(["EXISTS", kMeta(code)])) === 1;
  }

  return {
    async create(nickname) {
      let code = sixDigits();
      for (let i = 0; (await roomExists(code)) && i < 100; i++) code = sixDigits();
      const token = randomToken();
      const meta: RoomMeta = {
        createdAt: Date.now(),
        closed: false,
        closedAt: null,
        members: [{ id: token, token, nickname, isCreator: true }],
      };
      const id = await nextId(code);
      await pipe([
        ["SET", kMeta(code), JSON.stringify(meta), "EX", ROOM_TTL],
        [
          "RPUSH",
          kMsgs(code),
          JSON.stringify({
            id,
            kind: "system",
            memberId: null,
            nickname: "",
            text: `${nickname} 创建了房间，聊天内容将在关闭后焚毁`,
            ts: Date.now(),
          } satisfies ChatMessage),
        ],
        ["EXPIRE", kMsgs(code), ROOM_TTL],
        ["SET", kP(code, token), "1", "EX", PRESENCE_TTL],
      ]);
      return { code, token, memberId: token };
    },

    async join(code, nickname) {
      const meta = await getMeta(code);
      if (!meta || meta.closed) return null;
      const token = randomToken();
      meta.members.push({ id: token, token, nickname, isCreator: false });
      const id = await nextId(code);
      await pipe([
        ["SET", kMeta(code), JSON.stringify(meta), "EX", ROOM_TTL],
        [
          "RPUSH",
          kMsgs(code),
          JSON.stringify({
            id,
            kind: "system",
            memberId: null,
            nickname: "",
            text: `${nickname} 加入了房间`,
            ts: Date.now(),
          } satisfies ChatMessage),
        ],
        ["EXPIRE", kMsgs(code), ROOM_TTL],
        ["SET", kP(code, token), "1", "EX", PRESENCE_TTL],
      ]);
      return { code, token, memberId: token };
    },

    async state(code, token, sinceId) {
      const [metaRaw, msgsRaw] = await pipe([
        ["GET", kMeta(code)],
        ["LRANGE", kMsgs(code), 0, -1],
        ["EXPIRE", kMeta(code), ROOM_TTL],
        ["EXPIRE", kMsgs(code), ROOM_TTL],
      ]);
      if (typeof metaRaw !== "string") return { status: "gone" };
      let meta = JSON.parse(metaRaw) as RoomMeta;
      if (meta.closed) return { status: "closed", code };

      const me = meta.members.find((m) => m.token === token) ?? null;
      // 在线 = 成员在册 且 有心跳 key
      const presence = await pipe([
        ...(me ? [["SET", kP(code, token), "1", "EX", PRESENCE_TTL] as (string | number)[]] : []),
        ...meta.members.map((m) => ["EXISTS", kP(code, m.token)] as (string | number)[]),
      ]);
      const existsFlags = presence.slice(me ? 1 : 0).map(Number);
      const onlineIdx = new Set(meta.members.map((_, i) => i).filter((i) => existsFlags[i] === 1));

      // 房主掉线且还有其他在线成员 → 惰性移交房主
      const creatorIdx = meta.members.findIndex((m) => m.isCreator);
      if (creatorIdx >= 0 && !onlineIdx.has(creatorIdx) && onlineIdx.size > 0) {
        const nextIdx = Math.min(...onlineIdx);
        meta.members[creatorIdx].isCreator = false;
        meta.members[nextIdx].isCreator = true;
        const id = await nextId(code);
        meta = { ...meta };
        await pipe([
          ["SET", kMeta(code), JSON.stringify(meta), "EX", ROOM_TTL],
          [
            "RPUSH",
            kMsgs(code),
            JSON.stringify({
              id,
              kind: "system",
              memberId: null,
              nickname: "",
              text: `${meta.members[nextIdx].nickname} 成为房主`,
              ts: Date.now(),
            } satisfies ChatMessage),
          ],
        ]);
      }

      const messages = (Array.isArray(msgsRaw) ? msgsRaw : [])
        .map((s) => JSON.parse(String(s)) as ChatMessage)
        .filter((m) => m.id > sinceId);

      return {
        status: "ok",
        code,
        me: me ? { id: me.id, nickname: me.nickname, isCreator: me.isCreator } : null,
        members: meta.members
          .filter((_, i) => onlineIdx.has(i))
          .map((m) => ({ nickname: m.nickname, isCreator: m.isCreator })),
        messages,
        latestId: messages.length ? messages[messages.length - 1].id : 0,
      };
    },

    async send(code, token, text) {
      const meta = await getMeta(code);
      if (!meta) return "gone";
      if (meta.closed) return "closed";
      const me = meta.members.find((m) => m.token === token);
      if (!me) return "not_member";
      const id = await nextId(code);
      await pipe([
        ["RPUSH", kMsgs(code), JSON.stringify({ id, kind: "msg", memberId: me.id, nickname: me.nickname, text, ts: Date.now() } satisfies ChatMessage)],
        ["LTRIM", kMsgs(code), -MAX_MESSAGES, -1],
        ["EXPIRE", kMsgs(code), ROOM_TTL],
        ["SET", kP(code, token), "1", "EX", PRESENCE_TTL],
      ]);
      return "ok";
    },

    async leave(code, token) {
      const meta = await getMeta(code);
      if (!meta) return;
      const idx = meta.members.findIndex((m) => m.token === token);
      if (idx < 0) return;
      const [me] = meta.members.splice(idx, 1);
      if (!meta.closed) {
        // 房主离开 → 移交给最早加入的剩余成员
        if (me.isCreator && meta.members.length > 0) {
          meta.members[0].isCreator = true;
        }
        await pipe([["SET", kMeta(code), JSON.stringify(meta), "EX", ROOM_TTL], ["DEL", kP(code, token)]]);
        await pushMsg(code, {
          id: await nextId(code),
          kind: "system",
          memberId: null,
          nickname: "",
          text: `${me.nickname} 离开了房间`,
          ts: Date.now(),
        });
      } else {
        await pipe([["SET", kMeta(code), JSON.stringify(meta), "EX", BURNED_TTL], ["DEL", kP(code, token)]]);
      }
    },

    async burn(code, token) {
      const meta = await getMeta(code);
      if (!meta) return "gone";
      const me = meta.members.find((m) => m.token === token);
      if (!me) return "not_member";
      if (!me.isCreator) return "forbidden";
      const burned: RoomMeta = { ...meta, closed: true, closedAt: Date.now(), members: [] };
      await pipe([
        ["SET", kMeta(code), JSON.stringify(burned), "EX", BURNED_TTL],
        ["DEL", kMsgs(code), kSeq(code), ...meta.members.map((m) => kP(code, m.token))],
      ]);
      return "ok";
    },
  };
}

/* ────────────────────────── 选择后端 ────────────────────────── */

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export const store: Store =
  REDIS_URL && REDIS_TOKEN ? createRedisStore(REDIS_URL, REDIS_TOKEN) : createMemoryStore();
