import { ServiceChannels } from "@zcode/shared";

/** 外置等价port探针：只替换QA adapter，正式helper与Host协议不改。
 * 原TS callback的const receive/属性function会带入tsx keepNames __name闭包。
 * rawJS仅依赖当前renderer globals与传入的既有channel，不读取/写入产品持久化。
 */
export async function installLocalQaRpcProbe() {
  await browser.execute(`
    const channel=arguments[0];
    if(window.__remoteProjectHandoffRpc)throw new Error("QA refuses to replace an existing RPC adapter");
    const original=MessagePort.prototype.postMessage;
    let port;
    const probe={ready:false,call(request,prefixes){
      if(!port)throw new Error("Window Host port unavailable");
      const target=port;
      return new Promise(resolve=>{
        const receive=event=>{
          if(!(event.data instanceof Uint8Array))return;
          if(!prefixes.some(prefix=>prefix.every((byte,index)=>event.data[index]===byte)))return;
          target.removeEventListener("message",receive);resolve(Array.from(event.data));
        };
        target.addEventListener("message",receive);original.call(target,Uint8Array.from(request));
      });
    },restore(){MessagePort.prototype.postMessage=original;delete window.__remoteProjectHandoffRpc;}};
    Object.defineProperty(MessagePort.prototype,"postMessage",{configurable:true,writable:true,value:function(message,options){
      if(message instanceof Uint8Array&&new TextDecoder().decode(message).includes(channel)){port=this;probe.ready=true;}
      Reflect.apply(original,this,options===undefined?[message]:[message,options]);
    }});
    window.__remoteProjectHandoffRpc=probe;window.dispatchEvent(new Event("focus"));
  `, ServiceChannels.RemoteProjects);
  await browser.waitUntil(()=>browser.execute(()=>Boolean(window.__remoteProjectHandoffRpc?.ready)),{timeout:30_000,timeoutMsg:"QA did not capture the existing Window Host port"});
}
