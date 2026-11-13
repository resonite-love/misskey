/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {api, loadSite, eventually, savePrivateJson} from './lab.mjs';
import {readFileSync} from 'node:fs';

const g=loadSite('.',0), r=loadSite('../resonite-love-gridspace',1);
async function account(site){
	const admin=JSON.parse(readFileSync(site.accountsPath,'utf8')).accounts.admin;
	const password=randomBytes(20).toString('base64url');
	const user=await api(site,'admin/accounts/create',{username:'resources_'+randomBytes(4).toString('hex'),password},admin.token);
	return {...await api(site,'i',{},user.token),token:user.token,password};
}
const grid=await account(g), old=await account(r), other=await account(r);
const antenna=await api(r,'antennas/create',{name:'Shared antenna',src:'all',users:[],keywords:[['resource30']],excludeKeywords:[],caseSensitive:false,localOnly:false,excludeBots:false,withReplies:true,withFile:false,excludeNotesInSensitiveChannel:false},old.token);
const clip=await api(r,'clips/create',{name:'Shared clip',description:'before',isPublic:false},old.token);
const page=await api(r,'pages/create',{name:'resource'+Date.now(),title:'Shared page',content:[{id:'text',type:'text',text:'before'}],variables:[],script:''},old.token);
const otherPage=await api(r,'pages/create',{name:'other'+Date.now(),title:'Other page',content:[],variables:[],script:''},other.token);
const form=new FormData();form.set('i',old.token);form.set('force','true');form.set('file',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'art.png');
const fileResponse=await fetch(r.origin+'/api/drive/files/create',{method:'POST',body:form});assert.equal(fileResponse.status,200);const file=await fileResponse.json();
const gallery=await api(r,'gallery/posts/create',{title:'Shared gallery',fileIds:[file.id]},old.token);
const start=await api(g,'gridspace/link',{action:'start'},grid.token);
const transaction=(await(await fetch(start.authorizationUrl)).text()).match(/name="misskey:oauth:transaction-id" content="([^"]+)"/)?.[1];assert.ok(transaction);
const decision=await fetch(r.origin+'/oauth/decision',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({transaction_id:transaction,login_token:old.token})});
assert.equal(decision.status,302);const callback=new URL(decision.headers.get('location'));
await api(g,'gridspace/link',{action:'finish',code:callback.searchParams.get('code'),state:callback.searchParams.get('state'),issuer:callback.searchParams.get('iss'),clientKey:start.clientKey},grid.token);
const managed=(kind,action,id,data)=>api(g,'gridspace/managed-resource',{kind,action,id,data},grid.token);
for(const [kind,item] of [['antenna',antenna],['page',page],['clip',clip],['gallery',gallery]]){
	const list=await managed(kind,'list');assert.ok(list.items.some(row=>row.gridspaceOriginalId===item.id));
	await managed(kind,'update',item.id,kind==='antenna'?{name:'Updated antenna'}:kind==='clip'?{name:'Updated clip',description:'after'}:{title:'Updated '+kind});
}
assert.equal((await api(r,'antennas/show',{antennaId:antenna.id},old.token)).name,'Updated antenna');
assert.equal((await api(r,'clips/show',{clipId:clip.id},old.token)).description,'after');
assert.equal((await api(r,'pages/show',{pageId:page.id},old.token)).title,'Updated page');
assert.equal((await api(r,'gallery/posts/show',{postId:gallery.id},old.token)).title,'Updated gallery');
await assert.rejects(managed('page','update',otherPage.id,{title:'not allowed'}));
await assert.rejects(managed('page','delete',otherPage.id));
console.log('PASS: all four owned resource types update the original; unrelated owner is refused');
const editable=await managed('gallery','show',gallery.id);assert.equal(editable.item.files[0].url,file.url);assert.notEqual(editable.item.files[0].id,file.id);
await managed('gallery','update',gallery.id,{title:'Attachment preserved',fileIds:[editable.item.files[0].id]});
assert.equal((await api(r,'gallery/posts/show',{postId:gallery.id},old.token)).fileIds[0],file.id);
const ownUpload=new FormData();ownUpload.set('i',grid.token);ownUpload.set('force','true');ownUpload.set('file',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'grid.png');
const gUpload=await fetch(g.origin+'/api/drive/files/create',{method:'POST',body:ownUpload});assert.equal(gUpload.status,200);const ownFile=await gUpload.json();
const changedArt=await managed('gallery','update',gallery.id,{fileIds:[ownFile.id]});assert.equal(changedArt.item.files[0].id,ownFile.id);
const reopenedArt=await managed('gallery','show',gallery.id);assert.equal(reopenedArt.item.files[0].url,ownFile.url);
const ownNote=(await api(g,'notes/create',{text:'resource30 page note'},grid.token)).createdNote;
await eventually('paired note arrival',async()=>!!(await api(r,'ap/show',{uri:g.origin+'/notes/'+ownNote.id},old.token)).object);
await managed('page','update',page.id,{content:[{id:'image',type:'image',fileId:ownFile.id},{id:'note',type:'note',note:g.origin+'/notes/'+ownNote.id,detailed:false}]});
const updatedPage=await managed('page','show',page.id);assert.equal(updatedPage.item.content[0].fileId,ownFile.id);
assert.ok(!updatedPage.item.content[1].note.startsWith('https:'));
const localAntenna=await api(g,'antennas/create',{...antenna,id:undefined,name:'G antenna'},grid.token);
await api(r,'gridspace/managed-resource',{kind:'antenna',action:'update',id:localAntenna.id,data:{name:'Changed from R'}},old.token);
assert.equal((await api(g,'antennas/show',{antennaId:localAntenna.id},grid.token)).name,'Changed from R');
console.log('PASS: image references round-trip without copying; antenna editing also works in reverse');
const note=(await api(r,'notes/create',{text:'resource30 shared result'},old.token)).createdNote;
await eventually('native antenna collection',async()=> (await api(r,'antennas/notes',{antennaId:antenna.id},old.token)).some(row=>row.id===note.id));
const read=await api(g,'gridspace/private-notes',{mode:'antenna',antennaId:antenna.id},grid.token);assert.ok(read.notes.some(row=>row.id===note.id));
console.log('PASS: shared antenna reads the existing collection through the linked account');
savePrivateJson('.config/resources30-accounts.json',{grid,old,antenna,clip,page,gallery});
if(!process.argv.includes('--keep')){
	for(const [kind,item] of [['antenna',antenna],['page',page],['clip',clip],['gallery',gallery]])await managed(kind,'delete',item.id);
	for(const [endpoint,key,item] of [['antennas/show','antennaId',antenna],['pages/show','pageId',page],['clips/show','clipId',clip],['gallery/posts/show','postId',gallery]])await assert.rejects(api(r,endpoint,{[key]:item.id},old.token));
	console.log('PASS: deleting all four resources removes their source objects');
}
