export class Router {
  constructor(){ this.routes=[]; }
  add(method,path,handler){
    if(typeof handler!=='function') throw new TypeError('handler must be a function');
    const names=[];
    const pattern=path.split('/').map(p=>p.startsWith(':')?(names.push(p.slice(1)),'([^/]+)'):p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('/');
    this.routes.push({method:method.toUpperCase(),path,names,re:new RegExp(`^${pattern}$`),handler});
    return this;
  }
  match(method,urlPath){
    for(const r of this.routes){ if(r.method!==method.toUpperCase()) continue; const m=r.re.exec(urlPath); if(!m) continue; return {route:r,params:Object.fromEntries(r.names.map((n,i)=>[n,decodeURIComponent(m[i+1])]))}; }
    return null;
  }
}

export class CadenceApp {
  constructor(){ this.router=new Router(); this.middleware=[]; }
  use(fn){ this.middleware.push(fn); return this; }
  route(method,path,handler){ this.router.add(method,path,handler); return this; }
  get(path,handler){ return this.route('GET',path,handler); }
  post(path,handler){ return this.route('POST',path,handler); }
  async handle(request){
    const url=new URL(request.url,'http://cadence.local');
    const match=this.router.match(request.method,url.pathname);
    if(!match) return {status:404,headers:{'content-type':'application/json'},body:{error:'not_found'}};
    const ctx={request,params:match.params,state:{},status:200,headers:{},body:null};
    const chain=[...this.middleware, async c=>{ c.body=await match.route.handler(c); }];
    let index=-1;
    const dispatch=async i=>{ if(i<=index) throw new Error('next called multiple times'); index=i; const fn=chain[i]; if(fn) await fn(ctx,()=>dispatch(i+1)); };
    await dispatch(0);
    return {status:ctx.status,headers:ctx.headers,body:ctx.body};
  }
}

export const json = (schema) => async (ctx,next) => {
  if(ctx.request.body !== undefined){
    const value=ctx.request.body;
    const result=schema(value);
    if(result?.ok===false){ ctx.status=400; ctx.body={error:'validation_failed',issues:result.issues??[]}; return; }
    ctx.state.input=result?.value ?? value;
  }
  await next();
};
