/**
 * 角色的对象模型（实施包 B · B01 / B09 / B12 / B13，docs/admin-audit/02-plan.md §1.3）。
 *
 *   角色（base，大肥鱼）→ 形象（一个角色包 = 一套形象，「大肥鱼 · Live2D」）→ 服饰
 *
 * 图鉴按「角色」一位一张卡；计数全窗口统一写「N 位角色 · M 套形象」（CHAR-01）；状态四态只用一套词
 * （未拥有 / 还没见面 / 已遇见 / 正在陪你，STORE-02 · STG-03 · CHAT-02）。Home、Chat、Store、Shell 引用这里，
 * 不各自再数一遍。
 *
 * `met`（好感、名字）、模型、个性化设定都是原型的（core/roster.js），所以同一位角色的几套形象共用一个状态，
 * 只有「正在陪你」落在其中一套形象上。
 */
import type { CatalogRow, RosterRow } from './api';

/** 一位角色在图鉴里的状态（02-plan §1.3「状态词」）。 */
export type CharacterState = 'unowned' | 'unmet' | 'met' | 'current';

/** 状态词表：侧栏、卡片、详情页头、toast 用同一个词（W-03，CHAT-02）。 */
export const STATE_WORD: Record<CharacterState, string> = {
  current: '正在陪你',
  met: '已遇见',
  unmet: '还没见面',
  unowned: '未拥有',
};

/** 一位角色：她的几套形象，和图鉴卡片上代表她的那一套。 */
export interface CharacterGroup {
  accent: string;
  base: string;
  /** 商店里能下载、本机还没有的形象（「未拥有」的角色只有这些） */
  remote: CatalogRow[];
  /** 本机有的形象（roster 行），按 roster 顺序 */
  looks: RosterRow[];
  /** 卡片上画的、「切换 / 初次见面」作用到的那一套：正在陪你的那套，否则第一套 */
  lead: RosterRow | null;
  /** 原型名（大肥鱼）；起过名字的用她的名字 */
  name: string;
  state: CharacterState;
}

const stateOf = (looks: RosterRow[]): CharacterState => {
  if (!looks.length) return 'unowned';
  if (looks.some((c) => c.current)) return 'current';
  return looks.some((c) => c.met) ? 'met' : 'unmet';
};

/**
 * 把 roster（每套形象一行）收成角色（每位一组）。`pick` 决定卡片代表哪套形象（筛选时用匹配的那套）；
 * 商店里有、本机一套都没有的原型是「未拥有」。
 */
export const groupRoster = (roster: RosterRow[], catalog: CatalogRow[] = [], pick?: (c: RosterRow) => boolean): CharacterGroup[] => {
  const order: string[] = [];
  const by = new Map<string, RosterRow[]>();
  for (const c of roster) {
    if (!by.has(c.base)) {
      by.set(c.base, []);
      order.push(c.base);
    }
    by.get(c.base)!.push(c);
  }
  const groups: CharacterGroup[] = order.map((base) => {
    const looks = by.get(base)!;
    const pool = pick ? looks.filter(pick) : looks;
    const lead = pool.find((c) => c.current) ?? pool[0] ?? null;
    const any = looks[0];
    return {
      accent: any.accent,
      base,
      lead,
      looks,
      name: any.met?.name ?? any.nameZh,
      remote: catalog.filter((d) => d.base === base && !d.installed),
      state: stateOf(looks),
    };
  });
  // a base only the 商店 has (none of her looks on this machine): 未拥有
  const seen = new Set(order);
  for (const d of catalog) {
    if (d.installed || seen.has(d.base)) continue;
    seen.add(d.base);
    groups.push({ accent: '', base: d.base, lead: null, looks: [], name: d.name.split(' · ')[0] ?? d.name, remote: catalog.filter((x) => x.base === d.base && !x.installed), state: 'unowned' });
  }
  return groups;
};

/** 全窗口统一的计数口径：「5 位角色 · 13 套形象」（CHAR-01）。 */
export const countLabel = (roster: RosterRow[]) => {
  const bases = new Set(roster.map((c) => c.base)).size;
  return `${bases} 位角色 · ${roster.length} 套形象`;
};

/** 已遇见几位角色（按原型数，不按形象数）。 */
export const metCount = (roster: RosterRow[]) => new Set(roster.filter((c) => c.met).map((c) => c.base)).size;

/** 一套形象的状态（详情页头、侧栏用）：同一位角色共享「已遇见」，「正在陪你」只属于桌面上那一套。 */
export const lookState = (c: RosterRow): CharacterState => (c.current ? 'current' : c.met ? 'met' : 'unmet');

/**
 * 命名规则（CHAT-02）：角色用「名字」（起过名的用她的名字，否则原型名），某一套形象用「名字 · 形象」。
 * `c.name` 已经是「原型名 · 形象」，起过名字时把原型名换成她的名字。
 */
export const lookName = (c: RosterRow) => {
  const who = c.met?.name ?? c.nameZh;
  return c.label ? `${who} · ${c.label}` : who;
};

/**
 * 一个 id 指的是哪套形象（B13 / SH-04）：形象 id 本身；旧链接写原型 id（`#/characters/dafeiyu`，T-2764 之前）时，
 * 取她正在陪你的那套，否则第一套。Shell 面包屑与详情页共用这一套解析。
 */
export const resolveCharacter = (roster: RosterRow[], idOrBase: string | undefined | null): RosterRow | undefined => {
  if (!idOrBase) return undefined;
  return roster.find((x) => x.id === idOrBase) ?? roster.find((x) => x.base === idOrBase && x.current) ?? roster.find((x) => x.base === idOrBase);
};

/** 角色详情的标签（B02 / CHAR-02）：进 URL `#/characters/:id/:tab`。 */
export const DETAIL_TABS = ['looks', 'model', 'role', 'affection', 'about'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

/** 旧标签名（T-2784 之前的 outfits、CHAR-04 合并前的 voice）落到新标签。 */
export const toDetailTab = (raw: string | undefined | null): DetailTab => {
  if (raw === 'voice') return 'about';
  if (raw === 'outfits') return 'looks';
  return (DETAIL_TABS as readonly string[]).includes(raw ?? '') ? (raw as DetailTab) : 'looks';
};

/** 某位角色某个标签的地址。 */
export const detailHref = (id: string, tab: DetailTab = 'looks') => `#/characters/${id}/${tab}`;
