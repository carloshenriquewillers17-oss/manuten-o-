const CACHE_NAME='dmv-geradores-pwa-v16';
const APP_FILES=['./','./index.html','./styles.css?v=16','./app.js?v=16','./config.js','./manifest.json','./icon.svg','./apple-touch-icon.png','./icons/icon-192.png','./icons/icon-512.png','./icons/icon-512-maskable.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_FILES.map(url=>new Request(url,{cache:'reload'})))).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('dmv-geradores-pwa-')&&k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin||!url.href.startsWith(self.registration.scope))return;
 if(event.request.mode==='navigate'){
  event.respondWith(fetch(event.request).catch(()=>caches.match('./index.html')));return;
 }
 if(!APP_FILES.some(p=>new URL(p,self.registration.scope).href===url.href))return;
 event.respondWith(caches.open(CACHE_NAME).then(cache=>cache.match(event.request).then(cached=>cached||fetch(event.request))));
});
self.addEventListener('push',event=>{
 let data={};try{data=event.data?.json()||{};}catch{}
 event.waitUntil(self.registration.showNotification(data.title||'DMV Engenharia',{body:data.body||'Você tem um novo aviso.',tag:data.tag||'dmv-aviso',icon:new URL('./icons/icon-192.png',self.registration.scope).href,badge:new URL('./icons/icon-192.png',self.registration.scope).href,data:{url:self.registration.scope}}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{for(const client of clients){if(client.url.startsWith(self.registration.scope)){return client.focus();}}return self.clients.openWindow(self.registration.scope);}));
});
