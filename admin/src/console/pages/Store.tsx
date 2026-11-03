/**
 * 商店 (docs/characters.md 「内置与下载」): what can be downloaded. One tab per kind of thing — 角色 now; 声音包
 * and more can be added as tabs later. Downloaded characters stay listed here as 已下载 (→ her page) and show
 * up in 角色图鉴, which lists only the characters on this machine.
 */
import { Alert, Flexbox, Segmented, Text } from "@lobehub/ui";
import { PageHeader, PageTabs } from "@lobehub/ui/dashboard";
import { useState } from "react";

import { useStore } from "../store";
import { CatalogGrid, KIND_NAME } from "./Characters";

const CharactersShelf = () => {
  const { catalog: cat, view } = useStore();
  const catalog = cat ?? [];
  const [show, setShow] = useState<"all" | "remote" | "installed">("all");
  const remote = catalog.filter((d) => !d.installed).length;
  const items = catalog.filter(
    (d) =>
      show === "all" || (show === "installed" ? d.installed : !d.installed),
  );
  if (!catalog.length)
    return (
      <Alert
        description="目前没有可以下载的角色。"
        title="商店里还没有角色"
        type="info"
      />
    );
  return (
    <Flexbox gap={16}>
      <Flexbox
        align="center"
        gap={8}
        horizontal
        justify="space-between"
        wrap="wrap"
      >
        <div data-store-filter>
          <Segmented
            onChange={(v) => setShow(v as typeof show)}
            options={[
              { label: `全部 ${catalog.length}`, value: "all" },
              { label: `未下载 ${remote}`, value: "remote" },
              {
                label: `已下载 ${catalog.length - remote}`,
                value: "installed",
              },
            ]}
            size="small"
            value={show}
          />
        </div>
        <Text fontSize={12} type="secondary">
          {[...new Set(catalog.map((d) => KIND_NAME[d.kind] ?? d.kind))].join(
            " · ",
          )}
        </Text>
      </Flexbox>
      {!view && (
        <Alert
          description="先在桌宠窗口里选一位角色并完成唤醒；下载的角色会出现在角色图鉴里，在那里结识和切换。"
          showIcon
          title="还没有唤醒桌宠"
          type="info"
        />
      )}
      <CatalogGrid items={items} />
    </Flexbox>
  );
};

type Shelf = "characters";

export const StorePage = () => {
  // one tab per kind of thing on sale; add 声音包 etc. here
  const [tab, setTab] = useState<Shelf>("characters");
  return (
    <>
      <PageHeader
        description="下载更多内容。下载好的角色会出现在角色图鉴里，可以切换、换装；不需要了可以在她的页面删除下载。"
        title="商店"
      />
      <PageTabs
        label="商店分类"
        onChange={setTab}
        tabs={[
          { content: <CharactersShelf />, label: "角色", value: "characters" },
        ]}
        value={tab}
      />
    </>
  );
};
