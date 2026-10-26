/* Minimal DOM/browser shim so the real ES modules can be imported and smoke-tested
   in Node. It is NOT a DOM implementation — just enough to catch module-load errors,
   bad imports and top-level exceptions. */
class ClassList {
  constructor(){ this.s = new Set(); }
  add(...c){ c.forEach(x=>this.s.add(x)); } remove(...c){ c.forEach(x=>this.s.delete(x)); }
  toggle(c,f){ f===undefined ? (this.s.has(c)?this.s.delete(c):this.s.add(c)) : (f?this.s.add(c):this.s.delete(c)); }
  contains(c){ return this.s.has(c); }
}
class El {
  constructor(tag='div'){ this.tagName=tag.toUpperCase(); this.children=[]; this.dataset={};
    this.style=new Proxy({},{get:(t,k)=>t[k]??'',set:(t,k,v)=>{t[k]=v;return true}});
    this.classList=new ClassList(); this.attrs={}; this._html=''; this._text=''; this.parentNode=null;
    this.hidden=false; this.disabled=false; this.value=''; this.checked=false;
    this.offsetWidth=100; this.offsetParent={}; this.childElementCount=0; }
  set className(v){ this._cls=v; (v||'').split(/\s+/).filter(Boolean).forEach(c=>this.classList.add(c)); }
  get className(){ return this._cls||''; }
  set innerHTML(v){ this._html=String(v); this.children=[]; } get innerHTML(){ return this._html; }
  set textContent(v){ this._text=String(v); } get textContent(){ return this._text; }
  append(...n){ n.flat(9).forEach(x=>{ if(x==null) return; this.children.push(x); if(x.parentNode===undefined) x.parentNode=this; }); this.childElementCount=this.children.length; }
  appendChild(n){ this.append(n); return n; }
  remove(){ if(this.parentNode){ const i=this.parentNode.children.indexOf(this); if(i>=0) this.parentNode.children.splice(i,1); this.parentNode.childElementCount=this.parentNode.children.length; } }
  setAttribute(k,v){ this.attrs[k]=String(v); if(k==='hidden') this.hidden=true; }
  getAttribute(k){ return this.attrs[k]??null; }
  removeAttribute(k){ delete this.attrs[k]; }
  addEventListener(t,f){ (this._ev||(this._ev={}))[t]=(this._ev[t]||[]); this._ev[t].push(f); }
  removeEventListener(){}
  dispatchEvent(e){ (this._ev?.[e.type]||[]).forEach(f=>f(e)); return true; }
  querySelector(){ return new El('div'); } querySelectorAll(){ return []; }
  closest(){ return null; } focus(){} scrollIntoView(){} getBoundingClientRect(){ return {left:0,top:0,width:100,height:100,right:100,bottom:100}; }
  get firstChild(){ return this.children[0]||null; }
}
const registry = new Map();
globalThis.document = {
  documentElement: new El('html'), body: new El('body'), activeElement: null,
  createElement: t => new El(t), createTextNode: t => { const n=new El('#text'); n.textContent=t; return n; },
  getElementById(id){ if(!registry.has(id)) registry.set(id, new El('div')); return registry.get(id); },
  querySelector(){ return null; }, querySelectorAll(){ return []; },
  addEventListener(){}, removeEventListener(){},
};
globalThis.window = globalThis;
globalThis.location = { origin:'http://localhost', pathname:'/index.html', href:'http://localhost/index.html',
                        search:'', protocol:'http:', reload(){} };
globalThis.URLSearchParams = URLSearchParams;
globalThis.history = { replaceState(){}, pushState(){} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.navigator = { vibrate(){}, share:null, clipboard:null, sendBeacon(){return true}, userAgent:'node' };
globalThis.localStorage = (()=>{ const m=new Map(); return {
  getItem:k=>m.has(k)?m.get(k):null, setItem:(k,v)=>m.set(k,String(v)), removeItem:k=>m.delete(k), clear:()=>m.clear() }; })();
globalThis.matchMedia = q => ({ matches:/reduce/.test(q)?false:false, media:q, addEventListener(){}, removeEventListener(){} });
globalThis.addEventListener = ()=>{}; globalThis.removeEventListener = ()=>{};
globalThis.requestAnimationFrame = f => { setTimeout(()=>f(performance.now()),0); return 1; };
globalThis.cancelAnimationFrame = ()=>{};
globalThis.innerWidth = 390; globalThis.innerHeight = 844; globalThis.devicePixelRatio = 2;
globalThis.performance = globalThis.performance || { now:()=>Date.now() };
globalThis.fetch = async (url, opt) => {
  const u = String(url);
  if (u.includes('balance.json')) {
    const fs = await import('node:fs/promises');
    const txt = await fs.readFile(new URL('../htdocs/config/balance.json', import.meta.url), 'utf8');
    return { ok:true, status:200, json: async()=>JSON.parse(txt), headers:new Map([['X-Server-Time',String(Math.floor(Date.now()/1000))]]) , clone(){return this;} };
  }
  return { ok:true, status:200, json: async()=>({ok:true}), headers:{get:()=>null}, clone(){return this;} };
};
class Ctx2D { clearRect(){} beginPath(){} arc(){} fill(){} setTransform(){} }
El.prototype.getContext = () => new Ctx2D();
globalThis.Map = Map;
export { El, registry };
