/* FORGE INFINITE — cosmetic rendering.
   A cosmetic is data, not an asset: the `css` descriptor from balance.json becomes
   inline styles/animations. Zero image downloads, crisp at any DPI, and UI themes
   are literally CSS-variable swaps. */

import { esc, attr, RARITY_ICON, rarityLabel } from './fmt.js';
import { cssFor, RARITY_CSS } from './balance.js';

const GLYPH = {
  avatar: '🧑‍🔧', frame: '🖼️', background: '🌌', title: '🏷️', click_fx: '🖱️',
  win_fx: '✨', theme: '🎨', sound: '🔊', pet: '🐾', banner: '🏳️',
  signature: '✍️', badge: '🎖️', crate: '📦',
};

export const slotIcon = slot => GLYPH[slot] || '❔';

/** The avatar chip: glyph + frame ring + background + optional pet. */
export function avatarHTML(loadout, catalog, { size = 48, username = '' } = {}) {
  const av = loadout?.avatar && catalog?.[loadout.avatar];
  const fr = loadout?.frame && catalog?.[loadout.frame];
  const bg = loadout?.background && catalog?.[loadout.background];
  const pet = loadout?.pet && catalog?.[loadout.pet];

  const frameStyle = fr ? (cssFor(fr) || RARITY_CSS[fr.rarity] || '') : '';
  const bgStyle = bg ? cssFor(bg) : '';
  const glyph = av?.css?.glyph || GLYPH.avatar;
  const petGlyph = pet?.css?.glyph || '';

  return `<span class="avatar" style="width:${size}px;height:${size}px;${attr(bgStyle)}"
              ${username ? `title="${attr(username)}"` : ''}>
    <span class="avatar-glyph" style="font-size:${Math.round(size * 0.56)}px${av?.css?.anim ? `;animation:fi-${attr(av.css.anim)} 3s ease-in-out infinite` : ''}">${glyph}</span>
    ${fr ? `<span class="avatar-ring" style="${attr(frameStyle)}"></span>` : ''}
    ${petGlyph ? `<span class="avatar-pet" ${pet?.css?.anim ? `style="animation:fi-${attr(pet.css.anim)} 2.4s ease-in-out infinite"` : ''}>${petGlyph}</span>` : ''}
  </span>`;
}

/** Title pill rendered under a username everywhere (chat, ranks, profile). */
export function titleHTML(loadout, catalog) {
  const t = loadout?.title && catalog?.[loadout.title];
  if (!t) return '';
  const style = cssFor(t) || 'color:#FBBF24';
  return `<span class="title-pill" style="${attr(style)}">${esc(t.name)}</span>`;
}

export function badgeHTML(loadout, catalog) {
  const b = loadout?.badge && catalog?.[loadout.badge];
  if (!b) return '';
  return `<span class="badge-chip" title="${attr(b.name)}">${b.css?.glyph || '🎖️'}</span>`;
}

/** Signature line (player-authored → escaped). */
export function signatureHTML(loadout, catalog, settings) {
  const sig = settings?.signature;
  if (!sig) return '';
  const s = loadout?.signature && catalog?.[loadout.signature];
  return `<p class="signature"${s ? ` style="${attr(cssFor(s))}"` : ''}>${esc(sig)}</p>`;
}

/** Item card used by the shop, inventory and crate results. */
export function itemCardHTML(it, { owned = false, price = null, currency = null, affordable = true, action = '' } = {}) {
  const css = cssFor(it) || RARITY_CSS[it.rarity] || '';
  const curIcon = currency === 'gems' ? '💎' : currency === 'tokens' ? '🎖️' : '🪙';
  return `<button class="item-card r-${attr(it.rarity)}${owned ? ' owned' : ''}${!affordable ? ' cant' : ''}"
      data-action="${attr(action)}" data-item="${attr(it.id)}" type="button"
      aria-label="${attr(it.name)}, ${attr(rarityLabel(it.rarity))}${owned ? ', owned' : ''}">
    <span class="item-art" style="${attr(css)}">${slotIcon(it.slot)}</span>
    <span class="item-body">
      <span class="item-name">${esc(it.name)}</span>
      <span class="item-meta">
        <span class="rarity">${RARITY_ICON[it.rarity] || ''} ${esc(rarityLabel(it.rarity))}</span>
        ${owned ? '<span class="owned-tag">Owned</span>'
                : price !== null ? `<span class="price ${affordable ? 'ok' : 'no'}">${curIcon} ${price.toLocaleString('en-US')}</span>` : ''}
      </span>
    </span>
  </button>`;
}

/** Applies the equipped theme item (if any) — returns the theme key. */
export function themeFromLoadout(loadout, catalog) {
  const t = loadout?.theme && catalog?.[loadout.theme];
  return t?.css?.theme || null;
}

/** Click-FX descriptor for the forge tap handler. */
export function clickFx(loadout, catalog) {
  const f = loadout?.click_fx && catalog?.[loadout.click_fx];
  if (!f?.css) return null;
  return { count: f.css.particles || 10, color: f.css.color || '#FF7A18',
           life: f.css.life || 620, glow: !!f.css.glow };
}
