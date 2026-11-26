import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

export async function checkServerScreen({ root, page, api, until }) {
  const directory = path.join(root, "Temporary UI project 窗口");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({name:"native-ui-check",private:true}));
  const address = net.createServer();
  address.listen(0, "127.0.0.1");
  await once(address,"listening");
  const port = address.address().port;
  await new Promise(resolve => address.close(resolve));
  const stopKey = randomUUID();
  const script = path.join(directory,"server.cjs");
  await fs.writeFile(script,`
    const http=require("node:http");
    const app=http.createServer((req,res)=>{
      if(req.method==="POST" && req.url===${JSON.stringify("/"+stopKey)}) {
        res.end("closing"); app.close(); return;
      }
      res.end(String(process.pid));
    });
    app.listen(${port},"127.0.0.1",()=>console.log("ready"));
  `);
  const child=spawn(process.execPath,[script],{cwd:directory,windowsHide:true,stdio:["ignore","pipe","ignore"]});
  try {
    await once(child.stdout,"data");
    await page.getByRole("button",{name:/^Servers/}).click();
    await api("refresh");
    const service=await until(async()=>(await api("getServers")).find(row=>row.pid===child.pid && row.port===port && row.projectId && row.canStop),"fixture project identification");
    const ref={key:service.key,firstSeen:service.firstSeen};
    const project=await until(async()=>(await api("getProjects")).projects.find(p=>p.id===service.projectId),"project metadata");
    const menu=()=>page.getByRole("button",{name:"Actions for "+project.name,exact:true}).click();
    await menu();
    await page.getByRole("menuitem",{name:"Edit project",exact:true}).click();
    const editor=page.getByRole("dialog").filter({has:page.getByRole("textbox",{name:"Notes"})});
    await editor.getByRole("textbox",{name:"Notes"}).fill("WebView2 integration note");
    await editor.getByLabel("Pin",{exact:true}).check();
    await editor.getByRole("button",{name:"Save",exact:true}).click();
    await until(async()=>(await api("getProjects")).projects.some(p=>p.id===project.id && p.pinned && p.notes==="WebView2 integration note"),"saved project edit");
    await menu();
    await page.getByRole("menuitem",{name:"Activity",exact:true}).click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");

    await api("editProject",{...project,notes:"WebView2 integration note",pinned:true,ignored:true});
    await assert.rejects(api("stopServers",{refs:[ref],projectId:project.id}));
    assert.equal(await (await fetch("http://127.0.0.1:"+port)).text(),String(child.pid));
    await api("editProject",{...project,notes:"WebView2 integration note",pinned:true,ignored:false});
    await page.getByRole("checkbox",{name:"Select "+service.serviceName+" port "+port,exact:true}).check();
    const search=page.getByRole("textbox",{name:"Search dashboard"});
    await search.fill("absent-"+stopKey);
    await page.getByText(/1 hidden by search/).waitFor();
    await search.fill("");
    await page.getByRole("button",{name:"Stop Selected",exact:true}).click();
    await until(async()=>(await api("getProjects")).recentlyStopped.some(r=>r.key===service.key&&r.canStart),"verified stopped fixture");
    await page.getByRole("button",{name:"More services",exact:true}).click();
    const drawer=page.getByRole("dialog",{name:"More services"});
    await drawer.getByRole("button",{name:/Recently stopped/i}).click();
    const stoppedRow=drawer.getByRole("listitem").filter({has:page.getByText(":"+port,{exact:true})}).filter({has:page.getByTitle(service.serviceName,{exact:true})});
    await stoppedRow.getByRole("button",{name:"Start",exact:true}).click();
    const replacement=await until(async()=>(await api("getServers")).find(row=>row.port===port && row.pid!==child.pid),"restarted fixture listener");
    assert.equal(await (await fetch("http://127.0.0.1:"+port)).text(),String(replacement.pid));
    await drawer.getByRole("button",{name:"Close more services",exact:true}).click();
    return {id:project.id,port};
  } finally {
    // Only the server generated above recognizes this random shutdown route.
    await fetch("http://127.0.0.1:"+port+"/"+stopKey,{method:"POST",signal:AbortSignal.timeout(1500)}).catch(()=>{});
    if(child.exitCode===null && child.signalCode===null) child.kill();
  }
}
