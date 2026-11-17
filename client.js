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
        background: 'rgba(15, 23, 42, 0.32)',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        width: 'min(880px, 96vw)',
        maxHeight: 'min(88vh, 860px)',
        minHeight: 0,
        background: '#ffffff',
        color: '#111827',
        borderRadius: 12,
        border: '1px solid #e5e7eb',
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
        borderBottom: '1px solid #eef0f3',
        flex: '0 0 auto',
      },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      close: {
        border: 'none',
        background: 'transparent',
        color: '#6b7280',
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
      meta: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#6b7280' },
      metaRow: { display: 'flex', gap: 6, alignItems: 'baseline' },
      path: { fontFamily: MONO, color: '#1f2328', wordBreak: 'break-all' },
      group: { display: 'flex', flexDirection: 'column', gap: 4 },
      groupHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 0 2px',
        borderTop: '1px solid #f3f4f6',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
      },
      groupLabel: { flex: '0 0 auto' },
      groupPath: {
        fontSize: 11,
        color: '#9ca3af',
        fontWeight: 400,
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'right',
      },
      count: { fontSize: 11, color: '#9ca3af', fontWeight: 400, flex: '0 0 auto' },
      row: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13, lineHeight: '20px', minWidth: 0 },
      checkbox: { flex: '0 0 auto', width: 14, height: 14, margin: 0, accentColor: '#111827' },
      name: { fontFamily: MONO, flex: '0 0 auto' },
      description: {
        flex: '1 1 auto',
        minWidth: 0,
        color: '#6b7280',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      hidden: { color: '#c7cbd1' },
      hiddenName: { fontFamily: MONO, flex: '0 0 auto', color: '#9ca3af', textDecoration: 'line-through' },
      note: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#6b7280' },
      footer: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '12px 20px',
        borderTop: '1px solid #eef0f3',
        flex: '0 0 auto',
      },
      footerNote: { fontSize: 12, color: '#6b7280' },
      actions: { display: 'flex', gap: 8, flex: '0 0 auto' },
      button: {
        font: 'inherit',
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid #d1d5db',
        background: '#ffffff',
        color: '#111827',
        cursor: 'pointer',
      },
      primary: {
        font: 'inherit',
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid #111827',
        background: '#111827',
        color: '#ffffff',
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
        return h('div', { style: { ...styles.note, color: '#b91c1c' } }, `读取失败：${state.error}`);
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
                { key: 'no-skill-filter', style: { color: '#b91c1c' } },
                '注意：所有会话使用的共享 Skill 过滤没有装上；当前 Skill 策略不会可靠地应用。请重新加载插件并确认版本兼容。',
              )
            : null,
          data.mcpFilterInstalled === false
            ? h(
                'div',
                { key: 'no-mcp-filter', style: { color: '#b91c1c' } },
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
          h('span', {}, 'MCP 按整台 Server 控制：取消 comfyui 会隐藏并阻止所有 mcp__comfyui__* 工具，不提供单工具开关。'),
          h('span', {}, '保存后对这个工作区中的所有 preset 和已有会话生效；正在生成的回合不追溯修改，从下一次目录读取或模型请求开始使用新设置。'),
        ),
      ];
    }

    function WorkspaceSkillPanel() {
      const state = useSnapshot();

      React.useEffect(() => {
        if (!state.open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            closePanel();
          }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [state.open]);

      if (!state.open) return null;
      const dirty = isDirty(state);
      return h(
        'div',
        {
          style: styles.backdrop,
          onClick: (event) => {
            if (event.target === event.currentTarget) closePanel();
          },
        },
        h(
          'div',
          {
            style: styles.card,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '工作区能力范围',
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { style: styles.header },
            h('h2', { style: styles.title }, '工作区能力范围'),
            h('button', { type: 'button', style: styles.close, onClick: closePanel, 'aria-label': '关闭' }, '✕'),
          ),
          h('div', { style: styles.body }, panelBody(state)),
          h(
            'div',
            { style: styles.footer },
            h(
              'span',
              {
                style: {
                  ...styles.footerNote,
                  ...(state.saveError === undefined ? {} : { color: '#b91c1c' }),
                },
              },
              state.saveError ?? (dirty ? '有未保存的改动' : '已保存'),
            ),
            h(
              'div',
              { style: styles.actions },
              h('button', { type: 'button', style: styles.button, onClick: closePanel }, '取消'),
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
          ),
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
