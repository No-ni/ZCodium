/** 当前 @pierre/diffs 的 File 通过 open shadowRoot 渲染。
 * QA 只读 preview 下的代码行；父 textContent 不能证明该内容不存在。
 */
export async function readQaPreviewLines() {
  return browser.execute(`
    const pane=document.querySelector('[data-testid="preview-pane"]');
    if(!pane)return {container:false,shadowRoots:0,lines:[]};
    const roots=[pane],lines=[];let shadows=0;
    while(roots.length){const root=roots.shift();
      for(const line of root.querySelectorAll('[data-code] [data-line]')){
        const content=line.querySelector('[data-column-content]')||line;
        const raw=content.textContent||'';
        lines.push({line:line.getAttribute('data-line'),raw,normalized:raw.replace(/\\u00a0/g,' ').replace(/\\r?\\n$/,'')});
      }
      for(const host of root.querySelectorAll('*'))if(host.shadowRoot){roots.push(host.shadowRoot);shadows++;}
    }
    return {container:true,shadowRoots:shadows,lines};
  `) as Promise<{container:boolean;shadowRoots:number;lines:Array<{line:string|null;raw:string;normalized:string}>}>;
}
