import { useEffect, useRef, useState } from 'react';

/**
 * The menu in the top right corner.
 *
 * The left rail used to carry eight destinations, which mixed the four screens
 * a member of staff opens ten times a shift with the ones the owner opens once
 * a month. Everything that is not everyday work now lives here, grouped by how
 * often it is needed rather than by what it is (Designer).
 *
 * It is the same component on the counter screens and on the dark scan stage,
 * because the scan stage is where staff spend the shift and where a problem is
 * most likely to need reporting.
 */

/** The Designer's icon set: one path list each, drawn as a stroked outline. */
const ICONS = {
  gym: ['M3 4h18v16H3z', 'M3 10h18M3 15h18'],
  branding: ['M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z',
    'M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2'],
  packages: ['M3 5h18v14H3z', 'M3 10h18M9 19V10'],
  users: ['M9 4.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z',
    'M2.5 20c0-3.6 2.9-5.6 6.5-5.6s6.5 2 6.5 5.6', 'M17 11h5M19.5 8.5v5'],
  checkin: ['M4 6h16M4 12h16M4 18h10'],
  report: ['M4 20h4L19 9a2.5 2.5 0 0 0-4-4L4 16z'],
  manual: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M9.2 9.5a2.9 2.9 0 1 1 3.6 2.8v1.4', 'M12.3 16v1.4'],
  logout: ['M15.5 5.5a8 8 0 1 1-7 0', 'M12 3v8'],
  key: ['M15.5 4.5a4.5 4.5 0 1 0-3.6 7.2L4 19.6V21h3.4l1.2-1.2v-1.8h1.8l1.4-1.4v-1.8h1.8l1.1-1.1a4.5 4.5 0 0 0 .8-8.2Z',
    'M16.8 7.6h.01'],
  mail: ['M3 6h18v12H3z', 'm3 7 9 6 9-6'],
};

const Icon = ({ name }) => <span className="ic" aria-hidden="true">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round">
    {(ICONS[name] ?? []).map(d => <path key={d} d={d}/>)}
  </svg>
</span>;

/** Whoever is holding the tablet: the counter is shared, so this is not decoration. */
const who = user => ({
  initial: (user?.email ?? '?').trim().charAt(0).toUpperCase(),
  name: (user?.email ?? '').split('@')[0],
  email: user?.email ?? '',
  role: user?.role === 'admin' ? 'เจ้าของยิม' : 'พนักงาน',
});

export function UserMenu({ user, groups, onPick, footer }) {
  const [open, setOpen] = useState(false);
  const panel = useRef(null);
  const button = useRef(null);
  const me = who(user);

  const close = ({ toButton = false } = {}) => {
    setOpen(false);
    if (toButton) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); close({ toButton: true }); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      // A role="menu" is expected to move with the arrow keys, and on a
      // counter machine the keyboard is often the fastest thing there is.
      event.preventDefault();
      const items = [...(panel.current?.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
      if (!items.length) return;
      const at = items.indexOf(document.activeElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length].focus();
    };
    const onPointer = event => {
      if (!panel.current?.contains(event.target) && !button.current?.contains(event.target)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  // Opening a menu and leaving the focus behind on the button is how a menu
  // becomes unusable without a mouse.
  useEffect(() => {
    if (open) panel.current?.querySelector('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [open]);

  return <div className="usermenu">
    {/* Named "เมนู" rather than by its contents: the visible text is an initial,
        a truncated address and a chevron, which reads as noise out loud. Who is
        signed in is announced by the panel's own header. */}
    <button ref={button} className="avatar-btn" type="button" aria-haspopup="menu"
      aria-label="เมนู" aria-expanded={open} aria-controls="usermenu-panel"
      onClick={() => (open ? close({ toButton: true }) : setOpen(true))}>
      <span className="av" aria-hidden="true">{me.initial}</span>
      <span className="cav">{me.name}<span>{me.role}</span></span>
      <svg className="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>

    {open && <>
      {/* Only drawn on a phone, where the panel is a sheet at the bottom of the
          screen rather than a dropdown hanging off the corner. */}
      <div className="scrim" onClick={() => close()} aria-hidden="true"/>
      <div className="menupanel" id="usermenu-panel" role="menu" ref={panel}
        aria-label={`เมนูของ ${me.email}`}>
        <div className="who">
          <span className="av" aria-hidden="true">{me.initial}</span>
          <div><b>{me.email}</b><span>{me.role}</span></div>
        </div>

        {groups.map(group => <div className="menugroup" key={group.label ?? 'account'}>
          {group.label && <div className="gl">{group.label}</div>}
          {/* The note under a row is pointed at rather than nested inside the
              label: read as one string it comes out as "แจ้งปัญหาจับภาพหน้าจอ
              นี้ให้อัตโนมัติ" with no seam, which is a sentence nobody wrote
              (QA). `aria-describedby` keeps it available and separate. */}
          {group.items.map(item => <button key={item.key} type="button" role="menuitem"
            className={`mi${item.danger ? ' danger' : ''}`}
            aria-disabled={item.soon ? 'true' : undefined} disabled={item.soon || undefined}
            aria-label={item.sub ? item.label : undefined}
            aria-describedby={item.sub ? `usermenu-${item.key}-sub` : undefined}
            onClick={() => { close(); onPick(item); }}>
            <Icon name={item.icon}/>
            <span>{item.label}
              {item.sub && <span className="sub" id={`usermenu-${item.key}-sub`}>{item.sub}</span>}</span>
          </button>)}
        </div>)}

        {footer && <div className="foot">{footer}</div>}
      </div>
    </>}
  </div>;
}
