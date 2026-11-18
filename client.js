/**
 * Browser half of the Workspace Capability panel.
 *
 * Adds one row to a Session row's "..." menu that opens the workspace's skill
 * policy: every root the provider scans, every skill it found, and a checkbox
 * per group and per skill. Saving posts the policy to the Host, which rewrites
 * `.dsh/capability-scope.yml` and refreshes the mounted providers at once, so all
 * presets and existing Sessions in that workspace use the new set on their
 * next catalog read or model request.
 *
 * The panel is a self-contained overlay in `shell.overlay` (so it survives the
 * menu closing) rather than `Modal`: the shared dialog has a narrow fixed width,
 * and this panel has to stay readable on a narrow window.
 *
 * @module dsh-workspace-capability/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-capability',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { IconSkillOutlineRegular, MenuItemButton } = require('@deepseek-ai/dsh-client-ui-primitives');

    const ROUTE = '/dsh-workspace-capability';
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const GROUP_LABELS = {
      'project-dsh': '工作区 · .dsh/skills',
      'project-agents': '工作区 · .agents/skills',
      'user-dsh': '用户级 · ~/.dsh/skills',
      'user-agents': '用户级 · ~/.agents/skills',
      bundled: '内置 · bundled',
    };
    const GROUP_SWITCH = {
      'project-dsh': 'projectSkills',
      'project-agents': 'projectSkills',
      'user-dsh': 'userSkills',
      'user-agents': 'userSkills',
      bundled: 'bundled',
    };

    // --- panel state (module scope so the overlay can outlive the menu) -----
    let snapshot = {
      open: false,
      sessionId: undefined,
      status: 'idle',
      data: undefined,
      draft: undefined,
      error: undefined,
      saveError: undefined,
      saving: false,
    };
    const listeners = new Set();

    function publish(patch) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of [...listeners]) listener();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function useSnapshot() {
      const [, force] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => subscribe(force), []);
      return snapshot;
    }

    function deriveDraft(config) {
      return {
        projectSkills: config.projectSkills !== false,
        userSkills: config.userSkills !== false,
        bundled: config.bundled !== false,
        allow: [...(config.allow ?? [])],
        deny: [...(config.deny ?? [])],
        include: [...(config.include ?? [])],
        mcpServers: config.mcpServers === undefined ? undefined : [...config.mcpServers],
      };
    }

    function normalized(config) {
      return JSON.stringify({
        projectSkills: config.projectSkills,
        userSkills: config.userSkills,
        bundled: config.bundled,
        allow: [...config.allow].sort(),
        deny: [...config.deny].sort(),
        include: [...config.include].sort(),
        mcpServers: config.mcpServers === undefined ? undefined : [...config.mcpServers].sort(),
      });
    }

    function isDirty(state) {
      if (state.data === undefined || state.draft === undefined) return false;
      return normalized(state.draft) !== normalized(deriveDraft(state.data.config));
    }

    function groupOn(draft, key) {
      return draft[GROUP_SWITCH[key] ?? 'projectSkills'] !== false;
    }

    function skillVisible(draft, key, name) {
      if (draft.deny.includes(name)) return false;
      if (draft.include.includes(name)) return true;
      if (draft.allow.length > 0) return draft.allow.includes(name);
      return groupOn(draft, key);
    }

    async function openPanel(sessionId) {
      publish({
        open: true,
        sessionId,
        status: 'loading',
        data: undefined,
        draft: undefined,
        error: undefined,
        saveError: undefined,
        saving: false,
      });
      try {
        const response = await fetch(`${ROUTE}/catalog?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
        const body = await response.json().catch(() => undefined);
        if (snapshot.sessionId !== sessionId) return;
        if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
        publish({ status: 'ready', data: body, draft: deriveDraft(body.config) });
      } catch (error) {
        if (snapshot.sessionId !== sessionId) return;
        publish({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    }

    function closePanel() {
      publish({
        open: false,
        sessionId: undefined,
        status: 'idle',
        data: undefined,
        draft: undefined,
        error: undefined,
        saveError: undefined,
        saving: false,
      });
    }

    function toggleGroup(group) {
      const draft = snapshot.draft;
      if (draft === undefined) return;
      const names = group.skills.map((skill) => skill.name);
      const allVisible = names.length > 0 && names.every((name) => skillVisible(draft, group.key, name));
      const next = { ...draft, allow: [...draft.allow], deny: [...draft.deny], include: [...draft.include] };
      const nameSet = new Set(names);

      if (allVisible) {
        // A checked group checkbox means “clear all”, regardless of whether the
        // current visibility came from the group switch or explicit includes.
        next.deny = [...new Set([...next.deny, ...names])];
        next.allow = next.allow.filter((name) => !nameSet.has(name));
        next.include = next.include.filter((name) => !nameSet.has(name));
      } else {
        // A mixed or empty group checkbox means “select all”. Do not merely
        // flip the backing group switch: that would restore the previous
        // exceptions and leave the checkbox mixed, which is surprising UI.
        next.deny = next.deny.filter((name) => !nameSet.has(name));
        if (groupOn(next, group.key)) {
          if (next.allow.length > 0) next.allow = [...new Set([...next.allow, ...names])];
          next.include = next.include.filter((name) => !nameSet.has(name));
        } else {
          next.include = [...new Set([...next.include, ...names])];
        }
      }

      publish({ draft: next, saveError: undefined });
    }

    function toggleSkill(key, name) {
      const draft = snapshot.draft;
      if (draft === undefined) return;
      const next = { ...draft, allow: [...draft.allow], deny: [...draft.deny], include: [...draft.include] };
      const checked = !skillVisible(draft, key, name);
      if (!groupOn(draft, key)) {
        // The group is off, so a tick here is an explicit exception for one skill.
        next.include = checked ? [...new Set([...next.include, name])] : next.include.filter((item) => item !== name);
        next.deny = next.deny.filter((item) => item !== name);
      } else if (next.allow.length > 0) {
        next.allow = checked ? [...new Set([...next.allow, name])] : next.allow.filter((item) => item !== name);
        next.include = next.include.filter((item) => item !== name);
      } else if (checked) {
        next.deny = next.deny.filter((item) => item !== name);
        next.include = next.include.filter((item) => item !== name);
      } else {
        next.deny = [...new Set([...next.deny, name])];
      }
      publish({ draft: next, saveError: undefined });
    }

    function toggleMcpServer(name) {
      const draft = snapshot.draft;
      if (draft === undefined) return;
      const allNames = (snapshot.data?.mcpServers ?? []).map((server) => server.name);
      const selected = new Set(draft.mcpServers ?? allNames);
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
      const nextNames = allNames.filter((server) => selected.has(server));
      publish({
        draft: { ...draft, mcpServers: nextNames.length === allNames.length ? undefined : nextNames },
        saveError: undefined,
      });
    }

    async function savePanel() {
      const { data, draft, sessionId } = snapshot;
      if (data === undefined || draft === undefined || snapshot.saving) return;
      publish({ saving: true, saveError: undefined });
      try {
        const response = await fetch(`${ROUTE}/policy`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: data.workspace, session: sessionId, config: draft }),
        });
        const body = await response.json().catch(() => undefined);
        if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
        // The Host invalidates providers and broadcasts plugin-manager/changed,
        // which clears the shipped composer's private per-Session Skill cache.
        publish({ data: body, draft: deriveDraft(body.config), saving: false });
        closePanel();
      } catch (error) {
        publish({ saving: false, saveError: error instanceof Error ? error.message : String(error) });
      }
    }

    // --- Session row menu entry --------------------------------------------
    function WorkspaceSkillMenuItem({ sessionId, useMenuOpenState }) {
      // The row menu hands the entry a hook; without it there is nothing to
      // dismiss, and a button that cannot close the menu is worse than none.
      if (typeof useMenuOpenState !== 'function' || MenuItemButton === undefined) return null;
      const [, setMenuOpen] = useMenuOpenState();
      return h(
        MenuItemButton,
        {
          icon: h(IconSkillOutlineRegular, { size: 14 }),
          onSelect: () => {
            setMenuOpen(false);
            void openPanel(sessionId);
          },
        },
        '工作区能力范围…',
      );
    }

    // --- panel -------------------------------------------------------------
    const styles = {
      backdrop: {
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        paddingTop: 'var(--dsh-frame-overlay-top, 20px)',
        boxSizing: 'border-box',
        WebkitAppRegion: 'no-drag',
        background: 'rgba(15, 23, 42, 0.32)',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        width: 'min(1200px, 96vw)',
        maxHeight: 'min(88vh, 860px)',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 18,
        border: '1px solid var(--dsw-alias-border-l1)',
        boxShadow: '0 24px 60px rgba(15, 23, 42, 0.24)',
        overflow: 'hidden',
        fontSize: 13,
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '14px 20px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        flex: '0 0 auto',
      },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      close: {
        WebkitAppRegion: 'no-drag',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 18,
        lineHeight: '18px',
        cursor: 'pointer',
        padding: 4,
        borderRadius: 6,
      },
      body: {
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: '14px 20px',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        minHeight: 0,
        flex: '1 1 auto',
      },
      meta: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      metaRow: { display: 'flex', gap: 6, alignItems: 'baseline' },
      path: { fontFamily: MONO, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all' },
      group: { display: 'flex', flexDirection: 'column', gap: 4 },
      groupHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 0 2px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
      },
      groupLabel: { flex: '0 0 auto' },
      groupPath: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 400,
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'right',
      },
      count: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', fontWeight: 400, flex: '0 0 auto' },
      row: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13, lineHeight: '20px', minWidth: 0 },
      checkbox: { flex: '0 0 auto', width: 14, height: 14, margin: 0, accentColor: 'var(--dsw-alias-label-primary)' },
      name: { fontFamily: MONO, flex: '0 0 auto' },
      description: {
        flex: '1 1 auto',
        minWidth: 0,
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      hidden: { color: '#c7cbd1' },
      hiddenName: { fontFamily: MONO, flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)', textDecoration: 'line-through' },
      note: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      footer: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '12px 20px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        flex: '0 0 auto',
      },
      footerNote: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      actions: { display: 'flex', gap: 8, flex: '0 0 auto' },
      button: {
        font: 'inherit',
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      primary: {
        font: 'inherit',
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        cursor: 'pointer',
      },
      disabled: { opacity: 0.45, cursor: 'not-allowed' },
    };

    function skillRow(group, skill, draft) {
      const visible = skillVisible(draft, group.key, skill.name);
      const groupOff = !groupOn(draft, group.key);
      return h(
        'label',
        {
          key: skill.path,
          style: { ...styles.row, ...(groupOff && !visible ? { opacity: 0.55 } : {}) },
          title: `${skill.path}\n${skill.description ?? ''}`,
        },
        h('input', {
          type: 'checkbox',
          style: { ...styles.checkbox, cursor: 'pointer' },
          checked: visible,
          onChange: () => toggleSkill(group.key, skill.name),
        }),
        h('span', { style: visible ? styles.name : styles.hiddenName }, skill.name),
        h('span', { style: { ...styles.description, ...(visible ? {} : styles.hidden) } }, skill.description ?? ''),
      );
    }

    function groupBlock(group, draft) {
      const visible = group.skills.filter((skill) => skillVisible(draft, group.key, skill.name)).length;
      const allVisible = group.skills.length > 0 && visible === group.skills.length;
      const mixed = visible > 0 && !allVisible;
      const setIndeterminate = (element) => {
        if (element !== null) element.indeterminate = mixed;
      };
      return h(
        'div',
        { key: group.key, style: styles.group },
        h(
          'label',
          { style: styles.groupHead },
          h('input', {
            type: 'checkbox',
            style: styles.checkbox,
            checked: allVisible,
            ref: setIndeterminate,
            onChange: () => toggleGroup(group),
          }),
          h('span', { style: styles.groupLabel }, GROUP_LABELS[group.key] ?? group.key),
          h('span', { style: styles.count }, `${visible}/${group.skills.length} 可见`),
          h('span', { style: styles.groupPath }, group.path),
        ),
        group.skills.length === 0
          ? h('div', { style: { ...styles.note, paddingLeft: 22 } }, '（空目录）')
          : group.skills.map((skill) => skillRow(group, skill, draft)),
      );
    }

    function mcpBlock(servers, draft) {
      const allowed = new Set(draft.mcpServers ?? servers.map((server) => server.name));
      return h(
        'div',
        { key: 'mcp-servers', style: styles.group },
        h('div', { style: styles.groupHead },
          h('span', { style: styles.groupLabel }, 'MCP Server'),
          h('span', { style: styles.count }, `${allowed.size}/${servers.length} 可见`),
        ),
        servers.length === 0
          ? h('div', { style: { ...styles.note, paddingLeft: 22 } }, '（当前没有已连接的 MCP Server）')
          : servers.map((server) => h(
              'label',
              { key: server.name, style: styles.row },
              h('input', {
                type: 'checkbox',
                style: { ...styles.checkbox, cursor: 'pointer' },
                checked: allowed.has(server.name),
                onChange: () => toggleMcpServer(server.name),
              }),
              h('span', { style: allowed.has(server.name) ? styles.name : styles.hiddenName }, server.name),
              h(
                'span',
                { style: styles.description },
                server.connected === false
                  ? '当前未连接（保留既有配置）'
                  : `${server.toolCount} 个工具（整台 Server 一起控制）`,
              ),
            )),
      );
    }

    function panelBody(state) {
      if (state.status === 'loading' || state.status === 'idle') {
        return h('div', { style: styles.note }, '正在读取目录…');
      }
      if (state.status === 'error') {
        return h('div', { style: { ...styles.note, color: 'var(--dsw-alias-state-error-primary)' } }, `读取失败：${state.error}`);
      }
      const { data, draft } = state;
      return [
        h(
          'div',
          { key: 'meta', style: styles.meta },
          h('div', { style: styles.metaRow }, [
            h('span', { key: 'l', style: { flex: '0 0 auto' } }, '工作区'),
            h('span', { key: 'v', style: styles.path }, data.workspace),
          ]),
          h('div', { style: styles.metaRow }, [
            h('span', { key: 'l', style: { flex: '0 0 auto' } }, '策略文件'),
            h('span', { key: 'v', style: styles.path }, data.file),
            h('span', { key: 's', style: { flex: '0 0 auto' } }, data.fileExists ? '' : '（不存在 = 全部可用）'),
          ]),
          (data.skillFilterInstalled ?? data.filterInstalled) === false
            ? h(
                'div',
                { key: 'no-skill-filter', style: { color: 'var(--dsw-alias-state-error-primary)' } },
                '注意：所有会话使用的共享 Skill 过滤没有装上；当前 Skill 策略不会可靠地应用。请重新加载插件并确认版本兼容。',
              )
            : null,
          data.mcpFilterInstalled === false
            ? h(
                'div',
                { key: 'no-mcp-filter', style: { color: 'var(--dsw-alias-state-error-primary)' } },
                '注意：共享 MCP 工具过滤没有完整装上；当前 MCP Server 策略不会可靠地应用。请重新加载插件并确认版本兼容。',
              )
            : null,
          draft.allow.length > 0
            ? h(
                'div',
                { key: 'allow', style: { color: '#b45309' } },
                `此文件使用 allow 白名单（${draft.allow.length} 项），勾选会直接改白名单。`,
              )
            : null,
        ),
        ...data.groups.map((group) => groupBlock(group, draft)),
        mcpBlock(data.mcpServers ?? [], draft),
        h(
          'div',
          { key: 'note', style: styles.note },
          h('span', {}, '勾选状态就是这个工作区会话能看到的 skill；全部勾上 = 不额外隐藏目录中的 skill。'),
          h('span', {}, '整组关掉后仍然可以单独勾选：那个 skill 会写进 include，别的照样隐藏。'),
          h('span', {}, 'MCP 按整台 Server 控制：取消某台 Server 会隐藏并阻止它的全部 mcp__<server>__* 工具，不提供单工具开关。'),
          h('span', {}, '保存后对这个工作区中的所有 preset 和已有会话生效；正在生成的回合不追溯修改，从下一次目录读取或模型请求开始使用新设置。'),
        ),
      ];
    }

    const presetStyle = {
      field: { width: '100%', boxSizing: 'border-box', font: 'inherit', padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, background: 'var(--dsw-alias-bg-base)', color: 'inherit' },
      box: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, padding: 16, display: 'grid', gap: 12 },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
    };

    function PresetManager({ data, onDirty }) {
      const [catalog, setCatalog] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [original, setOriginal] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [searches, setSearches] = React.useState({ skills: '', mcpServers: '' });
      const [collapsed, setCollapsed] = React.useState({});
      const [capabilityTab, setCapabilityTab] = React.useState('skills');
      const metadata = value => value === null ? null : { name: value.name, displayName: value.displayName ?? value.name, description: value.description, skills: value.skills, mcpServers: value.mcpServers };
      const dirty = draft !== null && JSON.stringify(metadata(draft)) !== JSON.stringify(metadata(original));
      React.useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty]);
      React.useEffect(() => {
        let cancelled = false;
        fetch(`${ROUTE}/roles?workspace=${encodeURIComponent(data.workspace)}`, { cache: 'no-store' })
          .then(async r => { const value = await r.json(); if (!r.ok) throw new Error(value.error?.message ?? `HTTP ${r.status}`); return value; })
          .then(value => { if (!cancelled) setCatalog(value); })
          .catch(e => { if (!cancelled) setError(e.message); });
        return () => { cancelled = true; };
      }, [data.workspace]);
      const patch = value => { setDraft({ ...draft, ...value }); setNotice(''); };
      const choose = role => {
        if (dirty && !window.confirm('放弃当前预设未保存的修改？')) return;
        setDraft(role ? { ...role } : { displayName: '', description: '' });
        setOriginal(role ? { ...role } : null); setError(''); setNotice('');
      };
      async function persist(remove = false) {
        if (busy || !draft) return;
        if (remove && !window.confirm(`删除能力预设「${draft.displayName ?? draft.name}」？此操作不可撤销。`)) return;
        setBusy(true); setError(''); setNotice('');
        try {
          const response = await fetch(`${ROUTE}/roles`, {
            method: remove ? 'DELETE' : 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspace: data.workspace, ...(remove ? { name: draft.name } : { preset: { name: draft.name, displayName: draft.displayName ?? draft.name, description: draft.description, skills: draft.skills, mcpServers: draft.mcpServers }, create: original === null }) }),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
          setCatalog(body);
          const saved = remove ? null : body.roles.find(role => role.name === (body.savedId ?? draft.name));
          if (!remove && !saved) throw new Error('保存响应缺少预设，请重新读取后确认。');
          setOriginal(saved); setDraft(saved);
          setNotice(remove ? '预设已删除' : '预设已保存，父 Agent 下次读取名册即可选择。');
        } catch (e) { setError(e.message); } finally { setBusy(false); }
      }
      const displayName = draft?.displayName ?? draft?.name ?? '';
      const saveReason = !draft ? '' : busy ? '正在保存，请稍候' : !displayName.trim() ? '请填写预设名称（支持中文）' : displayName.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(displayName) ? '预设名称最多 100 个字符，且不能包含控制字符' : !draft.description.trim() ? '请填写推荐场景' : !dirty ? '没有未保存的修改' : '';
      const skillGroups = data.groups.map(group => ({ key: group.key, label: GROUP_LABELS[group.key] ?? group.key,
        items: group.skills.filter(skill => skillVisible(deriveDraft(data.config), group.key, skill.name)),
      })).filter(group => group.items.length > 0);
      const serverGroups = [{ key: 'servers', label: 'MCP Server', items: (data.mcpServers ?? []).filter(server => server.visible).map(server => ({ ...server,
        description: server.description || (server.connected ? `提供 ${server.toolCount ?? 0} 个工具；按整台 Server 授权。` : '当前未连接；按整台 Server 授权。'),
      })) }];
      function selector(field, title, groups) {
        const names = groups.flatMap(group => group.items.map(item => item.name));
        const selected = draft[field];
        const mode = selected === undefined ? 'inherit' : selected.length === 0 ? 'none' : 'custom';
        const custom = draft[`${field}Mode`] === 'custom' || mode === 'custom';
        const actualMode = custom ? 'custom' : mode;
        const missing = (selected ?? []).filter(n => !names.includes(n));
        const choiceGroups = [...groups, ...(missing.length ? [{ key: 'unavailable', label: '不可见 / 未连接 · 已保留', items: missing.map(name => ({ name, description: '当前目录不可用，调用前请检查父级可见范围。' })) }] : [])];
        const query = searches[field].trim().toLocaleLowerCase();
        const filteredGroups = choiceGroups.map(group => ({ ...group, items: group.items.filter(item =>
          [item.name, item.description, ...(item.tools ?? []).flatMap(tool => [tool.name, tool.description])]
            .filter(Boolean).join(' ').toLocaleLowerCase().includes(query)) })).filter(group => group.items.length > 0);
        function toggleNames(values, checked) {
          const next = new Set(selected ?? []);
          for (const name of values) { if (checked) next.add(name); else next.delete(name); }
          patch({ [field]: [...next], [`${field}Mode`]: 'custom' });
        }
        return h('section', { hidden: capabilityTab !== field, role: 'tabpanel', 'aria-label': title, style: { ...presetStyle.box, display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, overflow: 'hidden', ...(capabilityTab !== field ? { display: 'none' } : {}) } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('strong', {}, title), h('span', { style: presetStyle.muted }, selected === undefined ? '跟随父级' : `${selected.length} 项已选`)),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, ['inherit', 'none', 'custom'].map((value, i) => h('button', {
            key: value, type: 'button', disabled: busy, 'aria-pressed': actualMode === value,
            style: { ...styles.button, flex: 1, border: `1px solid ${actualMode === value ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`, background: actualMode === value ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-overlay)' },
            onClick: () => patch({ [field]: value === 'inherit' ? undefined : value === 'none' ? [] : selected ?? [], [`${field}Mode`]: value }),
          }, ['继承父级', '不使用', '自定义'][i]))),
          custom ? h('input', { className: 'wc-preset-field', type: 'search', style: presetStyle.field, value: searches[field],
            'aria-label': `搜索 ${title}`, placeholder: field === 'skills' ? '搜索 Skill 名称或描述…' : '搜索 MCP、工具名称或描述…',
            onChange: event => setSearches({ ...searches, [field]: event.target.value }) }) : null,
          custom && query ? h('span', { style: presetStyle.muted }, '搜索仅筛选展示；分组勾选仅作用于匹配项，其他选择保持不变。') : null,
          custom ? h('div', { 'aria-label': '能力列表', style: { display: 'grid', alignContent: 'start', gap: 14, overflowY: 'auto', overscrollBehavior: 'contain', minHeight: 0, flex: '1 1 auto', paddingRight: 4 } },
            filteredGroups.length === 0 ? h('span', { style: presetStyle.muted, role: 'status' }, query ? '没有匹配结果，试试其他关键词。' : '当前工作区没有可选项。') : null,
            filteredGroups.map(group => {
              const values = [...new Set(group.items.map(item => item.name))];
              const count = values.filter(name => (selected ?? []).includes(name)).length;
              const collapseKey = `${field}:${group.key}`;
              const expanded = Boolean(query) || !collapsed[collapseKey];
              return h('div', { key: group.key, style: { display: 'grid', gap: 8 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontSize: 12, fontWeight: 600 } },
                  h('input', { 'aria-label': `选择 ${group.label}`, type: 'checkbox', disabled: busy, style: styles.checkbox, checked: values.length > 0 && count === values.length,
                    ref: element => { if (element) element.indeterminate = count > 0 && count < values.length; },
                    onChange: event => toggleNames(values, event.target.checked) }),
                  h('button', { type: 'button', 'aria-expanded': expanded, 'aria-label': `${expanded ? '折叠' : '展开'} ${group.label}`,
                    disabled: Boolean(query), title: query ? '搜索时自动展开匹配结果' : undefined,
                    style: { display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', padding: '4px 0', cursor: query ? 'default' : 'pointer' },
                    onClick: () => setCollapsed({ ...collapsed, [collapseKey]: expanded }) },
                    expanded ? '▾' : '▸', group.label, h('span', { style: { ...presetStyle.muted, marginLeft: 'auto' } }, `${count}/${values.length}`))),
                (expanded ? group.items : []).map(item => h('label', { key: item.name, style: { display: 'flex', gap: 9, alignItems: 'flex-start', padding: '5px 4px', cursor: 'pointer' } },
                  h('input', { type: 'checkbox', disabled: busy, checked: (selected ?? []).includes(item.name), style: { ...styles.checkbox, marginTop: 3 }, onChange: event => toggleNames([item.name], event.target.checked) }),
                  h('span', { style: { display: 'grid', gap: 3, minWidth: 0 } },
                    h('span', { style: { fontFamily: MONO, overflowWrap: 'anywhere' } }, item.name),
                    h('span', { style: { ...presetStyle.muted, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, item.description || '暂无描述'),
                    item.tools?.length ? h('span', { style: { display: 'grid', gap: 5, marginTop: 3, paddingLeft: 9, borderLeft: '2px solid var(--dsw-alias-border-l1)' } }, item.tools.map(tool =>
                      h('span', { key: tool.name, style: { ...presetStyle.muted, overflowWrap: 'anywhere' } },
                        h('strong', { style: { fontFamily: MONO, fontWeight: 500 } }, tool.name), ' · ', tool.description || '暂无描述'))) : null))));
            })) : h('div', { style: presetStyle.muted }, mode === 'inherit' ? '创建子 Agent 时继承父 Agent 当前可见范围。' : '该类能力不提供给子 Agent；不影响 Bash 等原生工具。'),
          missing.length > 0 ? h('div', { style: presetStyle.muted }, '已保留不可见项；调用时若父级仍不可见，会拒绝创建。') : null);
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0, flex: '1 1 auto', overflow: 'hidden' } },
        h('span', { style: { ...presetStyle.muted, flexShrink: 0 } }, '配置 Skill 与 MCP 能力组合；推荐场景用于父 Agent 选择，不注入子 Agent 提示词。'),
        error ? h('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        notice ? h('div', { role: 'status', style: { color: 'var(--dsw-alias-state-success-primary)' } }, notice) : null,
        catalog === null ? h('span', { style: presetStyle.muted }, '正在读取能力预设…') : h('div', { className: 'wc-preset-layout', style: { overflow: 'hidden', minHeight: 0, flex: '1 1 auto', paddingRight: 4, overscrollBehavior: 'contain' } },
          h('aside', { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, minHeight: 0, overflowY: 'auto' } },
            h('button', { type: 'button', style: styles.primary, disabled: busy, onClick: () => choose(null) }, '＋ 新建能力预设'),
            catalog.roles.length === 0 ? h('p', { style: presetStyle.muted }, '还没有预设。把常用的能力组合保存下来，委托时无需重复选择。') : null,
            catalog.roles.map(role => h('button', { key: role.name, type: 'button', disabled: busy, onClick: () => choose(role), style: { ...presetStyle.box, textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer', background: draft?.name === role.name ? 'var(--dsw-alias-bg-layer-2)' : 'transparent', borderColor: draft?.name === role.name ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)', gap: 6 } },
              h('strong', { style: { overflowWrap: 'anywhere' } }, role.displayName ?? role.name), h('span', { style: { ...presetStyle.muted, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, role.description),
              h('span', { style: presetStyle.muted }, `Skill ${role.skills === undefined ? '继承' : role.skills.length} · MCP ${role.mcpServers === undefined ? '继承' : role.mcpServers.length}`))),
            (catalog.problems ?? []).map(problem => h('div', { key: problem.file, role: 'alert', style: presetStyle.muted }, `${problem.file}：${problem.message}`))),
          draft === null ? h('div', { style: { ...presetStyle.box, alignContent: 'center', textAlign: 'center', minHeight: 260 } }, h('strong', {}, '选择一个预设开始编辑'), h('p', { style: presetStyle.muted }, '能力有边界，任务由父 Agent 决定。')) :
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, minHeight: 0, overflow: 'hidden' } },
              h('div', { className: 'wc-preset-metadata', style: { flexShrink: 0 } },
              h('label', { style: { display: 'grid', gap: 7 } }, h('strong', {}, '预设名称'), h('input', { className: 'wc-preset-field', style: presetStyle.field, value: displayName, maxLength: 100, disabled: busy, placeholder: '例如 代码审查', onChange: e => patch({ displayName: e.target.value }), 'aria-label': '预设名称' }), h('span', { style: presetStyle.muted }, original ? `支持中文，可随时改名。调用标识：${draft.name}（保持不变）` : '支持中文；内部调用标识将在保存时自动生成。')),
              h('label', { style: { display: 'grid', gap: 7 } }, h('strong', {}, '推荐场景'), h('textarea', { className: 'wc-preset-field', style: { ...presetStyle.field, minHeight: 56, resize: 'vertical' }, value: draft.description, disabled: busy, placeholder: '适用于哪些任务？帮助父 Agent 判断何时选择此预设。', onChange: e => patch({ description: e.target.value }), 'aria-label': '推荐场景' }), h('span', { style: presetStyle.muted }, '仅供父 Agent 选择，不自动作为子 Agent 指令。'))),
              h('div', { role: 'tablist', 'aria-label': '能力类型', style: { display: 'flex', gap: 8, flexShrink: 0 } }, ['skills', 'mcpServers'].map((value, index) => h('button', {
                key: value, type: 'button', role: 'tab', 'aria-selected': capabilityTab === value,
                style: { ...styles.button, border: `1px solid ${capabilityTab === value ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`, background: capabilityTab === value ? 'var(--dsw-alias-bg-layer-2)' : 'transparent' },
                onClick: () => setCapabilityTab(value),
              }, `${['Skill', 'MCP'][index]} · ${draft[value] === undefined ? '继承' : draft[value].length + ' 项已选'}`))),
              selector('skills', 'Skill 能力', skillGroups), selector('mcpServers', 'MCP Server', serverGroups))),
        draft !== null ? h('div', { 'aria-label': '预设操作', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexShrink: 0, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 14, background: 'var(--dsw-alias-bg-overlay)' } },
                original !== null ? h('button', { type: 'button', style: { ...styles.button, color: 'var(--dsw-alias-state-error-primary)' }, disabled: busy, onClick: () => void persist(true) }, '删除预设') : h('span'),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
                   saveReason ? h('span', { id: 'wc-preset-save-reason', role: 'status', style: presetStyle.muted }, saveReason) : null,
                   h('button', { type: 'button', style: { ...styles.primary, ...(saveReason ? styles.disabled : {}) }, disabled: !!saveReason, 'aria-describedby': saveReason ? 'wc-preset-save-reason' : undefined, onClick: () => void persist() }, busy ? '处理中…' : '保存预设'))) : null);
    }

    function WorkspaceSkillPanel() {
      const state = useSnapshot();
      const [tab, setTab] = React.useState('scope');
      const presetDirty = React.useRef(false);
      const onPresetDirty = React.useCallback(value => { presetDirty.current = value; }, []);
      const [confirmClose, setConfirmClose] = React.useState(false);
      const requestClose = () => { if (isDirty(state) || presetDirty.current) { setConfirmClose(true); return; } closePanel(); };
      React.useEffect(() => { if (!state.open) setConfirmClose(false); }, [state.open]);

      React.useEffect(() => {
        if (!state.open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            requestClose();
          }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [state.open, state.draft, state.data]);

      if (!state.open) return null;
      const dirty = isDirty(state);
      return h(
        'div',
        {
          style: styles.backdrop,
          onClick: (event) => {
            if (event.target === event.currentTarget) requestClose();
          },
        },
        h(
          'div',
          {
            style: { ...styles.card, ...(tab === 'presets' ? { height: '100%', maxHeight: '100%' } : {}) },
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '工作区能力范围',
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { style: styles.header },
            h('h2', { style: styles.title }, '工作区能力范围'),
            h('button', { type: 'button', style: styles.close, onClick: requestClose, 'aria-label': '关闭', title: '关闭' }, '✕'),
          ),
          confirmClose ? h('div', { role: 'alertdialog', 'aria-label': '放弃未保存的修改？', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '12px 20px', flexShrink: 0, background: 'var(--dsw-alias-bg-layer-2)' } },
            h('span', { style: { flex: 1 } }, '有未保存的修改，确定放弃并关闭？'),
            h('button', { type: 'button', style: styles.button, onClick: () => setConfirmClose(false) }, '继续编辑'),
            h('button', { type: 'button', style: styles.primary, onClick: () => { setConfirmClose(false); presetDirty.current = false; closePanel(); } }, '放弃并关闭')) : null,
          h('style', {}, '.wc-preset-field:focus,.wc-preset-field:focus-visible{outline:none!important;box-shadow:none!important;border-color:var(--dsw-alias-state-business-primary)!important}.wc-preset-layout{display:grid;grid-template-columns:200px minmax(0,1fr);gap:20px;align-items:stretch}.wc-preset-metadata{display:grid;grid-template-columns:minmax(180px,1fr) minmax(0,2fr);gap:14px;align-items:start}@media(max-width:640px){.wc-preset-layout,.wc-preset-metadata{grid-template-columns:1fr}}'),
          h('div', { role: 'tablist', style: { display: 'flex', gap: 6, padding: '12px 20px 0' } }, ['scope', 'presets'].map((value, i) => h('button', { key: value, role: 'tab', type: 'button', 'aria-selected': tab === value, style: { ...styles.button, borderColor: tab === value ? 'var(--dsw-alias-brand-primary)' : 'transparent', background: tab === value ? 'var(--dsw-alias-bg-layer-2)' : 'transparent' }, onClick: () => { if (presetDirty.current && !window.confirm('放弃当前预设未保存的修改？')) return; setTab(value); } }, ['工作区范围', '能力预设'][i]))),
          h('div', { style: { ...styles.body, ...(tab === 'presets' ? { overflowY: 'hidden' } : {}) } }, tab === 'presets' && state.status === 'ready' ? h(PresetManager, { data: state.data, onDirty: onPresetDirty }) : panelBody(state)),
          tab === 'scope' ? h(
            'div',
            { style: styles.footer },
            h(
              'span',
              {
                style: {
                  ...styles.footerNote,
                  ...(state.saveError === undefined ? {} : { color: 'var(--dsw-alias-state-error-primary)' }),
                },
              },
              state.saveError ?? (dirty ? '有未保存的改动' : '已保存'),
            ),
            h(
              'div',
              { style: styles.actions },
              h('button', { type: 'button', style: styles.button, onClick: requestClose }, '取消'),
              h(
                'button',
                {
                  type: 'button',
                  style: { ...styles.primary, ...(dirty && !state.saving ? {} : styles.disabled) },
                  disabled: !dirty || state.saving,
                  onClick: () => void savePanel(),
                },
                state.saving ? '保存中…' : '保存',
              ),
            ),
          ) : null,
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'workspace-capability', order: 60 }, WorkspaceSkillPanel),
        );
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'workspace-capability', order: 460 },
            WorkspaceSkillMenuItem,
          ),
        );
      },
    };
  },
});
