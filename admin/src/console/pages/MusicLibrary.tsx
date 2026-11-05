/**
 * 角色详情 → 音乐: the songs she composed (core/music-library.js; keyed by her base id, so every look of hers shows them) — newest first, each one playable with the same
 * card as 聊天 (MusicCard), plus when and where she wrote it, what was asked, 重命名 (the title only) and 删除 (the
 * song and its file). The list refreshes when a song is added / renamed / deleted in any window.
 */
import { Button, Flexbox, Input, Tag, Text, toast } from '@lobehub/ui';
import { Surface } from '@lobehub/ui/dashboard';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api, type LibrarySong, type RosterRow } from '../api';
import { ask } from '../fields';
import { MusicCard } from './MusicCard';

const when = (t: number) => (t ? new Date(t).toLocaleString('zh-CN', { day: 'numeric', hour: '2-digit', hour12: false, minute: '2-digit', month: 'numeric', year: 'numeric' }) : '');
const WHERE: Record<LibrarySong['kind'], string> = { chat: '桌宠聊天', console: '设置窗口聊天' };

// What was asked, in one short line: style words first, then the prompt.
const askedOf = (r: LibrarySong['request']) => [r.genre, r.mood, r.scene, r.instruments, r.vocals].filter(Boolean).join(' · ') || r.prompt || '';

const SongRow = ({ song, onChanged }: { onChanged: () => void; song: LibrarySong }) => {
  const lib = api().musicLibrary;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(song.title);
  const [busy, setBusy] = useState(false);
  const title = song.title || '新曲子';

  const save = async () => {
    const t = draft.trim();
    if (!t) return toast.error('歌名不能是空的');
    if (t === song.title) return setEditing(false);
    setBusy(true);
    try {
      const r = await lib.rename(song.id, t);
      if (!r.ok) return toast.error('改名没成功：这首歌可能已经被删除了');
      toast.success(`已改名为《${r.song.title}》`);
      setEditing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await ask(
      `删除《${title}》？`,
      song.exists ? '会从她的音乐库移除，并删除这首歌的音频文件，删除后找不回来。聊天记录里她说的话会保留。' : '音频文件已经不在了，只会从她的音乐库移除这条记录。',
      song.exists ? '删除这首歌' : '移除记录',
      true,
    );
    if (!ok) return;
    const r = await lib.remove(song.id);
    if (!r.ok) return toast.error(r.message || '删除没成功：这首歌可能已经被删除了');
    toast.success(song.exists ? `已删除《${title}》` : `已移除《${title}》的记录`);
    onChanged();
  };

  const asked = askedOf(song.request);
  return (
    <div data-library-song={song.id} data-song-exists={song.exists ? 'yes' : 'no'}>
      <MusicCard
        actions={
          <>
            {!editing && (
              <Button data-song-rename icon={Pencil} onClick={() => { setDraft(song.title); setEditing(true); }} size="small" type="text">
                重命名
              </Button>
            )}
            <Button danger data-song-delete icon={Trash2} onClick={remove} size="small" type="text">
              删除
            </Button>
          </>
        }
        heading={
          editing ? (
            <Flexbox align="center" gap={4} horizontal>
              <Input
                aria-label="歌名"
                autoFocus
                data-song-title-input
                maxLength={60}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') save();
                  if (e.key === 'Escape') setEditing(false);
                }}
                size="small"
                value={draft}
              />
              <Button aria-label="保存歌名" data-song-title-save icon={Check} loading={busy} onClick={save} size="small" type="text" />
              <Button aria-label="取消改名" icon={X} onClick={() => setEditing(false)} size="small" type="text" />
            </Flexbox>
          ) : undefined
        }
        meta={
          <Flexbox gap={2}>
            <Text data-song-when fontSize={12} type="secondary">
              {[when(song.createdAt), `在${WHERE[song.kind]}里写的`].filter(Boolean).join(' · ')}
            </Text>
            {asked && (
              <Text data-song-asked ellipsis fontSize={12} title={song.request.prompt || asked} type="secondary">
                {asked}
              </Text>
            )}
          </Flexbox>
        }
        missing={!song.exists}
        music={{ ...song, fileUrl: '', libraryId: song.id }}
        wide
      />
    </div>
  );
};

export const MusicTab = ({ c }: { c: RosterRow }) => {
  const lib = api().musicLibrary;
  const [songs, setSongs] = useState<LibrarySong[] | null>(null);
  // her own name (not the look's): the songs are hers whichever look she wears
  const name = c.nameZh || c.name || '她';
  // her songs belong to her (the base: one agent and one 聊天记录 per character), whichever of her looks is shown
  const who = c.base || c.id;
  const load = useCallback(() => {
    lib.list(who).then((r) => setSongs(r.songs));
  }, [who, lib]);
  useEffect(() => {
    load();
    return lib.onChanged((e) => {
      if (e.speciesId === who) load();
    });
  }, [who, lib, load]);

  const lyrics = songs ? songs.filter((s) => !s.instrumental).length : 0;
  return (
    <Surface
      description={songs?.length ? `${songs.length} 首 · 有人声 ${lyrics} 首 · 纯音乐 ${songs.length - lyrics} 首 · 最新的在最上面` : '她在聊天里为你写的歌都会收在这里。'}
      title={`${name}写的歌`}
    >
      {songs === null ? (
        <Text type="secondary">读取中…</Text>
      ) : !songs.length ? (
        <Flexbox data-library-empty gap={4}>
          <Text strong>她还没有写过歌</Text>
          <Text fontSize={12} type="secondary">
            在聊天里对她说「给我写首歌」或「来段轻松的纯音乐」，写好的歌会出现在这里。需要先在 设置 → 音乐创作 选好服务并填好 Key。
          </Text>
        </Flexbox>
      ) : (
        <Flexbox data-library-list={who} gap={12}>
          {songs.some((s) => !s.exists) && (
            <Tag color="warning" style={{ alignSelf: 'flex-start' }}>
              有 {songs.filter((s) => !s.exists).length} 首的音频文件找不到了
            </Tag>
          )}
          {songs.map((s) => (
            <SongRow key={s.id} onChanged={load} song={s} />
          ))}
        </Flexbox>
      )}
    </Surface>
  );
};
