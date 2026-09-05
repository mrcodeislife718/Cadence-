export class Router {
  constructor(){ this.routes=[]; }
  add(method,path,...args){
    let options={};
    if(args[0] && typeof args[0]==='object' && typeof args[0]!=='function' && !Array.isArray(args[0])) options={...args.shift()};
    const handlers=args;
    if(!handlers.length || handlers.some((handler)=>typeof handler!=='function')) throw new TypeError('route handlers must be functions');
    const names=[];
    const pattern=path.split('/').map(p=>p.startsWith(':')?(names.push(p.slice(1)),'([^/]+)'):p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('/');
    this.routes.push({
      method:method.toUpperCase(),path,names,re:new RegExp(`^${pattern}$`),handlers,
      operationId:options.operationId??null,
      summary:options.summary??null,
      tags:Array.isArray(options.tags)?[...options.tags]:null,
      requestSchema:options.requestSchema??null,
      responses:options.responses??null,
      validate:typeof options.validate==='function'?options.validate:null
    });
    return this;
  }
  match(method,urlPath){
    for(const route of this.routes){
      if(route.method!==method.toUpperCase()) continue;
      const match=route.re.exec(urlPath);
      if(!match) continue;
      return {route,params:Object.fromEntries(route.names.map((name,index)=>[name,decodeURIComponent(match[index+1])]))};
    }
    return null;
  }
}

export class CadenceApp {
  constructor(){ this.router=new Router(); this.middleware=[]; }
  use(fn){ if(typeof fn!=='function') throw new TypeError('middleware must be a function'); this.middleware.push(fn); return this; }
  route(method,path,...args){ this.router.add(method,path,...args); return this; }
  get(path,...args){ return this.route('GET',path,...args); }
  post(path,...args){ return this.route('POST',path,...args); }
  put(path,...args){ return this.route('PUT',path,...args); }
  patch(path,...args){ return this.route('PATCH',path,...args); }
  delete(path,...args){ return this.route('DELETE',path,...args); }
  async handle(request){
    const url=new URL(request.url,'http://cadence.local');
    const match=this.router.match(request.method,url.pathname);
    if(!match) return {status:404,headers:{'content-type':'application/json'},body:{error:'not_found'}};
    const ctx={request,params:match.params,state:{},status:200,headers:{},body:null,route:match.route};
    const routeHandlers=[];
    if(match.route.validate){
      routeHandlers.push(async(context,next)=>{
        const result=await match.route.validate(context.request.body,context);
        if(result?.ok===false){context.status=400;context.body={error:'validation_failed',issues:result.issues??[]};return;}
        if(result && Object.hasOwn(result,'value')) context.state.input=result.value;
        await next();
      });
    }
    routeHandlers.push(...match.route.handlers.map((handler,index,all)=> index===all.length-1
      ? async (context,next)=>{ const result=await handler(context,next); if(result!==undefined) context.body=result; }
      : handler));
    const chain=[...this.middleware,...routeHandlers];
    let cursor=-1;
    const dispatch=async index=>{
      if(index<=cursor) throw new Error('next called multiple times');
      cursor=index;
      const fn=chain[index];
      if(fn) await fn(ctx,()=>dispatch(index+1));
    };
    await dispatch(0);
    return {status:ctx.status,headers:ctx.headers,body:ctx.body};
  }
}

export const json = (schema) => async (ctx,next=async()=>{}) => {
  if(ctx.request.body !== undefined){
    const value=ctx.request.body;
    const result=await schema(value,ctx);
    if(result?.ok===false){ ctx.status=400; ctx.body={error:'validation_failed',issues:result.issues??[]}; return; }
    ctx.state.input=result?.value ?? value;
  }
  await next();
};
