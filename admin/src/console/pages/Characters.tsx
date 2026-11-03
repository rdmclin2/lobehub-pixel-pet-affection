/**
 * 角色模块（实施包 B）：角色图鉴 (P-02) · 角色详情 (P-03 + P-04) · 角色包 / 导入角色 (P-02)。Data: core/roster.js
 * rows, rebuilt in main on every change, so a switch made here shows in the pet window and the other way round;
 * roster-model.ts groups them into characters (角色 → 形象 → 服饰).
 *
 * 1300 行的单文件拆成 ./character/*（行为不变，只为支撑层级与流程重构），这里保留原来的导出，ConsoleApp、
 * Store 等的 import 不用改。
 */
export { CharacterDetailPage } from './character/DetailPage';
export { PacksPage } from './character/PacksPage';
export { CharactersPage } from './character/RosterPage';
export { CatalogCard, CatalogGrid, downloading, KIND_NAME, KindTag, modelLabel, SwitchButton, useDownloads, useSwitch } from './character/shared';
