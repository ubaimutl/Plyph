import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import PlyphExtension from './subject.js';
import {SelectionCapture} from './shell/selectionCapture.js';
import {ResultDialog, AskDialog, ErrorDialog} from './shell/dialogs.js';
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');
const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT,ms,()=>{resolve();return GLib.SOURCE_REMOVE;}));
function assert(ok,description){if(!ok)throw new Error(description);print(`PLYPH-NATIVE: PASS ${description}`);}
export default class NativeTest extends Extension {
    enable(){this._timer=GLib.timeout_add(GLib.PRIORITY_DEFAULT,2500,()=>{this._timer=0;this.run().catch(error=>{print('PLYPH-NATIVE: FAIL '+error.message+'\n'+error.stack);global.context.terminate();});return GLib.SOURCE_REMOVE;});}
    disable(){if(this._timer)GLib.Source.remove(this._timer);this._dialog?.destroy();}
    async run(){
        const backend=global.stage.context?.get_backend() ?? Clutter.get_default_backend();
        const seat=backend.get_default_seat();
        const keyboard=seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const pointer=seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const time=()=>GLib.get_monotonic_time();
        const combo=async(...keys)=>{
            for(const key of keys)keyboard.notify_keyval(time(),key,Clutter.KeyState.PRESSED);
            await delay(35);
            for(const key of keys.toReversed())keyboard.notify_keyval(time(),key,Clutter.KeyState.RELEASED);
            await delay(90);
        };
        const clipboard=St.Clipboard.get_default();
        const read=()=>new Promise(resolve=>clipboard.get_text(St.ClipboardType.CLIPBOARD,(_c,text)=>resolve(text)));
        if (GLib.find_program_in_path('firefox')) {
        const selection=global.display.get_selection();
        const moveTo=async(x,y)=>{for(let attempt=0;attempt<6;attempt++){const [px,py]=global.get_pointer();pointer.notify_relative_motion(time(),x-px,y-py);await delay(60);}};
        const profile=`${this.path}/firefox-profile`;GLib.mkdir_with_parents(profile,0o700);
        GLib.file_set_contents(`${profile}/user.js`, 'user_pref("browser.aboutwelcome.enabled", false);user_pref("browser.shell.checkDefaultBrowser", false);user_pref("browser.startup.homepage_override.mstone", "ignore");');
        const image=GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,true,8,16,16);image.fill(0xc45f35ff);image.savev(`${profile}/image.png`,'png',[],[]);
        GLib.file_set_contents(`${profile}/capture.html`,'<title>Plyph capture test</title><textarea style="position:fixed;inset:0;width:100%;height:100%" id="input">Firefox native selection</textarea><img src="image.png" style="position:fixed;right:20px;bottom:20px;width:80px;height:80px"><script>window.onload=()=>{input.focus();input.select();}</script>');
        const launcher=new Gio.SubprocessLauncher({flags:Gio.SubprocessFlags.STDOUT_SILENCE});
        launcher.setenv('WAYLAND_DISPLAY','wayland-0',true);launcher.setenv('MOZ_ENABLE_WAYLAND','1',true);launcher.setenv('GDK_BACKEND','wayland',true);
        const firefox=launcher.spawnv(['firefox','--no-remote','--profile',profile,GLib.filename_to_uri(`${profile}/capture.html`,null)]);
        try{
            let win;
            for(let i=0;i<100;i++){
                win=global.get_window_actors().map(a=>a.meta_window).find(w=>w.get_title()?.includes('Plyph capture test'));
                if(win)break;
                await delay(100);
            }
            assert(Boolean(win),'Firefox test page opens');
            win.activate(global.get_current_time());await delay(300);
            assert(global.display.focus_window===win,'Firefox test page has focus');
            await delay(500);
            const rect=win.get_frame_rect();
            await moveTo(rect.x+rect.width/2,rect.y+rect.height/2);
            pointer.notify_button(time(),1,Clutter.ButtonState.PRESSED);await delay(50);
            pointer.notify_button(time(),1,Clutter.ButtonState.RELEASED);await delay(100);
            await combo(Clutter.KEY_Control_L,Clutter.KEY_a);
            clipboard.set_text(St.ClipboardType.CLIPBOARD,'Original before Firefox');await delay(100);
            const events=[];
            const signal=selection.connect('owner-changed',(_s,type,source)=>{events.push({type,active:source?.is_active(),formats:selection.get_mimetypes(type),focused:global.display.focus_window===win});});
            const external=new SelectionCapture();
            external.watchImages(selection,()=>true);
            try{
              for(const preserve of [true,true,false,false,true]){
                const previous=await read();
                const result=await external.capture({selection,clipboard,isCurrent:()=>!global.display.focus_window||global.display.focus_window===win,
                    strict:false,preserve,copy:()=>PlyphExtension.prototype._copy.call({_keyboard:keyboard})});
                assert(result==='Firefox native selection','Real Firefox compatibility capture returns selected text');
                assert(await read()===(preserve?previous:'Firefox native selection'),'Real Firefox compatibility capture respects preservation');
              }
              await combo(Clutter.KEY_Control_L,Clutter.KEY_a);
              clipboard.set_text(St.ClipboardType.CLIPBOARD,'ubaida   helldo howdw are u');
              await combo(Clutter.KEY_Control_L,Clutter.KEY_v);
              await combo(Clutter.KEY_Home);
              for(let i=0;i<6;i++)await combo(Clutter.KEY_Shift_L,Clutter.KEY_Right);
              await combo(Clutter.KEY_Control_L,Clutter.KEY_c);
              assert(await read()==='ubaida','Firefox user sequence: copies ubaida');
              await combo(Clutter.KEY_Home);
              for(let i=0;i<9;i++)await combo(Clutter.KEY_Right);
              await combo(Clutter.KEY_Control_L,Clutter.KEY_Shift_L,Clutter.KEY_End);
              const captureSuffix=()=>external.capture({selection,clipboard,strict:false,isCurrent:()=>true,
                  copy:()=>PlyphExtension.prototype._copy.call({_keyboard:keyboard})});
              assert(await captureSuffix()==='helldo howdw are u','Firefox user sequence: captures only the correction target');
              const replacement=Object.create(PlyphExtension.prototype);
              replacement._client={};replacement._keyboard=keyboard;replacement._clipboard=clipboard;
              replacement._selectionCapture=external;replacement._pendingDelays=new Map();
              replacement._settings={get_boolean:key=>key==='preserve-clipboard'};
              replacement._showFeedback=(message,state)=>{if(state==='error')throw new Error(message);};
              replacement._setIcon=()=>{};replacement._rememberUndo=()=>{};replacement._discardConsumedPrimary=()=>{};
              await replacement._replace('Hello, how are you?',false,'Replaced',win,null);
              assert(await read()==='ubaida','Firefox user sequence: Replace preserves ubaida on the clipboard');
              await combo(Clutter.KEY_Control_L,Clutter.KEY_a);
              const corrected=await captureSuffix();
              assert(corrected==='ubaida   Hello, how are you?','Firefox user sequence: corrected text actually replaced only the selected suffix: '+corrected);
              await combo(Clutter.KEY_Control_L,Clutter.KEY_v);
              await combo(Clutter.KEY_Control_L,Clutter.KEY_a);
              assert(await captureSuffix()==='ubaida','Firefox user sequence: subsequent Ctrl+V pastes ubaida');
              await moveTo(rect.x+rect.width-60,rect.y+rect.height-60);
              pointer.notify_button(time(),3,Clutter.ButtonState.PRESSED);await delay(50);
              pointer.notify_button(time(),3,Clutter.ButtonState.RELEASED);await delay(200);
              await combo(Clutter.KEY_y);await delay(300);
              const readImage=async()=>{
                  const stream=Gio.MemoryOutputStream.new_resizable();
                  await new Promise((resolve,reject)=>selection.transfer_async(Meta.SelectionType.SELECTION_CLIPBOARD,'image/png',8*1024*1024+1,stream,null,(_s,result)=>{try{selection.transfer_finish(result);resolve();}catch(e){reject(e);}}));
                  stream.close(null);return Array.from(stream.steal_as_bytes().get_data()).join(',');
              };
              const copiedImage=await readImage();
              assert(copiedImage.length>0,'Firefox Copy Image supplies PNG data');
              await moveTo(rect.x+rect.width/2,rect.y+rect.height/2);
              pointer.notify_button(time(),1,Clutter.ButtonState.PRESSED);await delay(50);
              pointer.notify_button(time(),1,Clutter.ButtonState.RELEASED);await delay(100);
              await combo(Clutter.KEY_Control_L,Clutter.KEY_a);
              assert(await captureSuffix()==='ubaida','Firefox Copy Image: action captures selected text');
              await delay(150);const restoredImage=await readImage();
              assert(restoredImage===copiedImage,'Firefox Copy Image: capture restores exact PNG bytes');
              await replacement._replace('Corrected image-case text',false,'Replaced',win,null);
              assert(await readImage()===copiedImage,'Firefox Copy Image: Replace restores exact PNG bytes');

            }catch(error){throw new Error(`${error.message}; clipboard=${JSON.stringify(await read())}; Firefox clipboard events: ${JSON.stringify(events)}`);}
            finally{external.destroy();selection.disconnect(signal);}
        }finally{firefox.force_exit();}
        }
        const edit=async(field,name)=>{
            field.clutter_text.set_text('Original text');field.clutter_text.grab_key_focus();
            clipboard.set_text(St.ClipboardType.CLIPBOARD,'Hello 🌍\nSecond line');
            await combo(Clutter.KEY_Control_L,Clutter.KEY_a);
            await combo(Clutter.KEY_Control_L,Clutter.KEY_v);
            const expected='Hello 🌍\nSecond line';
            assert(field.clutter_text.get_text()===expected,`${name}: paste replaces selected text (${JSON.stringify(field.clutter_text.get_text())})`);
            await combo(Clutter.KEY_Control_L,Clutter.KEY_a);
            await combo(Clutter.KEY_Control_L,Clutter.KEY_c);
            assert(await read()===expected,`${name}: copy selection`);
            await combo(Clutter.KEY_Control_L,Clutter.KEY_x);
            assert(field.clutter_text.get_text()==='',`${name}: cut selection`);
            await combo(Clutter.KEY_Control_L,Clutter.KEY_v);
            assert(field.clutter_text.get_text()===expected,`${name}: paste after cut`);
        };
        const copy=async(field,name,expected)=>{
            field.clutter_text.grab_key_focus();
            await combo(Clutter.KEY_Control_L,Clutter.KEY_a);
            await combo(Clutter.KEY_Control_L,Clutter.KEY_c);
            assert(await read()===expected,`${name}: copies readable text`);
            await combo(Clutter.KEY_Control_L,Clutter.KEY_v);
            assert(field.clutter_text.get_text()===expected,`${name}: remains read-only`);
        };
        const d=new ResultDialog('Original result',()=>{},()=>{},()=>{},null,null,'Source',false,
            {iconsPath:this.path+'/icons',run:async()=>'Refined result',discuss:async()=>'**Formatted reply**',destroy(){}});
        this._dialog=d;d.open();await delay(250);
        await edit(d._label,'Result editor');
        d._label.clutter_text.grab_key_focus();d._label.clutter_text.set_selection(-1,-1);await combo(Clutter.KEY_Return);
        assert(!d._finished&&d._label.clutter_text.get_text().endsWith('\n'),'Result editor: Enter inserts newline without closing');
        d._toggleRefinement();await edit(d._refineEntry,'Refinement input');
        d._refineEntry.set_text('Refine it');d._refineEntry.clutter_text.grab_key_focus();await combo(Clutter.KEY_Return);await delay(100);
        assert(!d._finished&&d._label.clutter_text.get_text()==='Refined result','Refinement Enter submits without applying result');
        d._toggleRefinement(true);await edit(d._refineEntry,'Discussion input');
        d._refineEntry.set_text('Question');d._refineEntry.clutter_text.grab_key_focus();await combo(Clutter.KEY_Return);await delay(150);
        assert(!d._finished&&d._discussion.length===2,'Discussion Enter submits without applying result');
        const reply=d._discussionMessages.get_children()[1]._body;
        await delay(100);
        const [replyX,replyY]=reply.clutter_text.get_transformed_position();
        const [replyWidth,replyHeight]=reply.clutter_text.get_transformed_size();
        const moveTo=async(x,y)=>{for(let attempt=0;attempt<4;attempt++){const [px,py]=global.get_pointer();pointer.notify_relative_motion(time(),x-px,y-py);await delay(50);}};
        await moveTo(replyX+2,replyY+replyHeight/2);
        pointer.notify_button(time(),1,Clutter.ButtonState.PRESSED);await delay(80);
        for(let step=0;step<4;step++){pointer.notify_relative_motion(time(),Math.min(18,replyWidth/5),0);await delay(50);}
        pointer.notify_button(time(),1,Clutter.ButtonState.RELEASED);await delay(100);
        assert(reply.clutter_text.get_selection().length>0,'Discussion reply: native mouse text selection');
        const highlight=reply.clutter_text.get_selection_color();
        const selectedInk=reply.clutter_text.get_selected_text_color();
        assert(reply.clutter_text.selection_color_set&&reply.clutter_text.selected_text_color_set,'Discussion reply: explicit selection colors');
        assert(highlight.to_string()!==selectedInk.to_string(),'Discussion reply: selection has visible contrast');
        assert(!reply.clutter_text.editable,'Discussion reply: selection does not enable editing');
        const captureReply=async name=>{
            await delay(80);
            const [x,y]=reply.get_transformed_position();const [width,height]=reply.get_transformed_size();
            const stream=Gio.MemoryOutputStream.new_resizable();
            await new Shell.Screenshot().screenshot_area(Math.floor(x),Math.floor(y),Math.ceil(width),Math.ceil(height),stream);
            stream.close(null);
            const bytes=stream.steal_as_bytes();
            const directory=GLib.getenv('PLYPH_NATIVE_CAPTURE_DIR');
            if(directory){GLib.mkdir_with_parents(directory,0o700);GLib.file_set_contents(`${directory}/${name}.png`,bytes.get_data());}
            const input=Gio.MemoryInputStream.new_from_bytes(bytes);
            const pixels=GdkPixbuf.Pixbuf.new_from_stream(input,null).get_pixels();
            input.close(null);
            return pixels;
        };
        const selectedPixels=await captureReply('selected');
        const selectionStart=reply.clutter_text.get_cursor_position();
        const selectionEnd=reply.clutter_text.get_selection_bound();
        reply.clutter_text.set_selection(0,0);
        const unselectedPixels=await captureReply('unselected');
        const changed=selectedPixels.reduce((count,value,index)=>count+(value!==unselectedPixels[index]?1:0),0);
        assert(changed>100,`Discussion reply: mouse selection visibly changes rendered pixels (${changed} channels)`);
        reply.clutter_text.set_selection(selectionStart,selectionEnd);
        await copy(reply,'Discussion reply','Formatted reply');
        const click=async actor=>{
            const [x,y]=actor.get_transformed_position();const [width,height]=actor.get_transformed_size();
            await moveTo(x+width/2,y+height/2);
            pointer.notify_button(time(),1,Clutter.ButtonState.PRESSED);await delay(50);
            pointer.notify_button(time(),1,Clutter.ButtonState.RELEASED);await delay(100);
        };
        await click(d._discussionMessages.get_children()[1]._copyButton);
        assert(await read()==='**Formatted reply**','Discussion copy icon: native click copies complete response');
        assert(d._discussionMessages.get_children()[1]._copyButton.accessible_name==='Response copied','Discussion copy icon: success feedback');
        d._discussionMessages.destroy_all_children();
        const longAnswer='**A wrapped reply**\n\n'+('A sentence with enough words to wrap across several lines. ').repeat(35)+'\n\n```js\nconst greeting = "Hello 🌍";\nconsole.log(greeting);\n```';
        const longRow=d._addDiscussionMessage('assistant',longAnswer);
        d._resizePreview();await delay(150);d._discussionScroll.vadjustment.value=0;await delay(100);
        const selectRange=async(start,end,label)=>{
            const text=longRow._body.clutter_text;
            const [x,y]=text.get_transformed_position();
            const [,sx,sy,sh]=text.position_to_coords(start);
            const [,ex,ey,eh]=text.position_to_coords(end);
            text.set_selection(0,0);
            await moveTo(x+sx+1,y+sy+sh/2);
            pointer.notify_button(time(),1,Clutter.ButtonState.PRESSED);await delay(80);
            for(let step=1;step<=6;step++){
                const [px,py]=global.get_pointer();
                pointer.notify_relative_motion(time(),x+sx+(ex-sx)*step/6+1-px,y+sy+sh/2+(ey+eh/2-sy-sh/2)*step/6-py);
                await delay(45);
            }
            pointer.notify_button(time(),1,Clutter.ButtonState.RELEASED);await delay(80);
            assert(text.get_selection().length>=end-start-2,label);
            await combo(Clutter.KEY_Control_L,Clutter.KEY_c);
            assert(await read()===text.get_selection(),`${label}: copy selected portion`);
        };
        await selectRange(2,115,'Wrapped reply: mouse selection across lines');
        const adjustment=d._discussionScroll.vadjustment;
        adjustment.value=adjustment.upper-adjustment.page_size;await delay(150);
        const codeStart=Array.from(longRow._body.clutter_text.get_text()).length-27;
        await selectRange(codeStart,codeStart+20,'Scrolled reply: mouse selection in code');
        await click(longRow._copyButton);
        assert(await read()===longAnswer,'Long reply copy icon: preserves Markdown, code and Unicode');
        d._refineStatus.set_text('Failure details');d._statusScroll.visible=true;d._resizePreview();await delay(100);
        await copy(d._refineStatus,'Inline status','Failure details');
        d._statusScroll.visible=false;
        const drag=async(label,legacy=false)=>{
            await delay(120);
            const before=d._scroll.height;
            const [x,y]=d._divider.get_transformed_position();const [width,height]=d._divider.get_transformed_size();
            await moveTo(50,50);
            for(let attempt=0;attempt<4;attempt++){
                const [px,py]=global.get_pointer();pointer.notify_relative_motion(time(),x+width/2-px,y+height/2-py);await delay(50);
            }
            pointer.notify_button(time(),1,Clutter.ButtonState.PRESSED);await delay(80);
            if(legacy){
                d._endDividerDrag();
                const [px,py]=global.get_pointer();
                d._beginDividerDrag({get_button:()=>1,get_coords:()=>[px,py]});
                global.stage.disconnect(d._dividerDragId);d._dividerDragId=null;
            }
            for(let step=0;step<4;step++){pointer.notify_relative_motion(time(),0,20);await delay(40);}
            pointer.notify_button(time(),1,Clutter.ButtonState.RELEASED);await delay(100);
            assert(d._scroll.height>before+30,`${label}: native mouse drag resizes result (${before} -> ${d._scroll.height}, divider ${x},${y},${width},${height})`);
            assert(!d._dividerGrab,`${label}: releases pointer grab`);
            assert(!d._dividerPollId,`${label}: stops pointer tracking on release`);
        };
        d._label.clutter_text.set_text('Short');d._splitRatio=null;d._resizePreview();await drag('Short result');
        d._label.clutter_text.set_text(('Long result with multiple lines.\n').repeat(60));d._splitRatio=null;d._resizePreview();await drag('Long result');
        d._toggleExpanded({});d._splitRatio=null;d._resizePreview();await drag('Enlarged result');
        if(d._dividerPan)d._divider.remove_action(d._dividerPan);
        d._splitRatio=null;d._resizePreview();await drag('Legacy pointer tracking without stage events',true);
        d._divider.grab_key_focus();const before=d._scroll.height;
        await combo(Clutter.KEY_Up);assert(d._scroll.height<before,'Divider keyboard resizing');
        await combo(Clutter.KEY_Home);assert(d._splitRatio===null,'Divider keyboard reset');
        d.destroy();this._dialog=null;await delay(120);
        const error=new ErrorDialog('Readable error',()=>{});this._dialog=error;error.open();await delay(150);
        const findLabel=root=>{if(root instanceof St.Label&&root.clutter_text.get_text()==='Readable error')return root;for(const child of root.get_children()){const found=findLabel(child);if(found)return found;}return null;};
        const errorLabel=findLabel(error.contentLayout);
        await copy(errorLabel,'Error dialog','Readable error');error.close();this._dialog=null;await delay(120);
        const plain=new ResultDialog('Selectable result',()=>{},()=>{},()=>{},null,null,'Original result');
        this._dialog=plain;plain.open();await delay(150);
        for(const [field,name] of [[plain._label,'Result editor'],[plain._diffLabel,'Comparison']]){
            field.show();field.ensure_style();await delay(50);
            const text=field.clutter_text;
            assert(text.selection_color_set&&text.selected_text_color_set,`${name}: themed selection colors without refinement`);
            assert(text.get_selection_color().to_string()!==text.get_selected_text_color().to_string(),`${name}: readable selection contrast`);
        }
        plain.destroy();this._dialog=null;await delay(100);

        let submitted='';let closed=false;
        const ask=new AskDialog(text=>{submitted=text;},null,()=>{closed=true;});this._dialog=ask;ask.open();await delay(150);
        ask._entry.clutter_text.grab_key_focus();await combo(Clutter.KEY_Return);
        assert(!ask._finished&&!closed&&ask._inputError.visible,'Empty Ask stays open with feedback');
        await edit(ask._entry,'Ask input');
        ask._entry.set_text('  Explain this  ');ask._entry.clutter_text.grab_key_focus();await combo(Clutter.KEY_Return);
        assert(submitted==='Explain this'&&closed,'Valid Ask submits after empty attempt');this._dialog=null;
        const captureDialog=new ResultDialog('Firefox selection 🌍',()=>{},()=>{},()=>{},null,null);
        this._dialog=captureDialog;captureDialog.open();await delay(150);
        const capture=new SelectionCapture();
        const selection=global.display.get_selection();
        const captureSelected=()=>{
            captureDialog._label.clutter_text.grab_key_focus();
            captureDialog._label.clutter_text.set_selection(0,-1);
            return capture.capture({selection,clipboard,isCurrent:()=>true,
                copy:()=>{void combo(Clutter.KEY_Control_L,Clutter.KEY_c);}});
        };
        for(const original of ['Original clipboard 🌍','']){
            clipboard.set_text(St.ClipboardType.CLIPBOARD,original);await delay(70);
            assert(await captureSelected()==='Firefox selection 🌍','Compatibility copy: captures a fresh native selection');
            await delay(130);
            assert(await read()===original,'Compatibility copy: restores original text including empty text');
        }
        const png=new Uint8Array([137,80,78,71,0,255]);
        clipboard.set_content(St.ClipboardType.CLIPBOARD,'image/png',new GLib.Bytes(png));await delay(70);
        assert(await captureSelected()==='Firefox selection 🌍','Compatibility copy: captures text over an image clipboard');
        await delay(130);
        const restored=await new Promise((resolve,reject)=>{
            const stream=Gio.MemoryOutputStream.new_resizable();
            selection.transfer_async(Meta.SelectionType.SELECTION_CLIPBOARD,'image/png',1024,stream,null,(_s,result)=>{
                try{selection.transfer_finish(result);stream.close(null);resolve(new Uint8Array(stream.steal_as_bytes().get_data()));}
                catch(error){reject(error);}
            });
        });
        assert(restored&&Array.from(restored).join(',')===Array.from(png).join(','),'Compatibility copy: restores exact binary bytes and MIME type');
        const reader=Object.create(PlyphExtension.prototype);
        reader._pendingClipboardReads=new Set();
        let completeRead;
        reader._clipboard={get_text:(_type,callback)=>{completeRead=callback;}};
        assert(await reader._getClipboardText(St.ClipboardType.PRIMARY)==='',
            'PRIMARY clipboard: real GLib timeout settles a missing callback');
        completeRead(null,'Late selection');
        assert(reader._pendingClipboardReads.size===0,'PRIMARY clipboard: timeout removes pending reads and ignores late data');
        reader._clipboard=clipboard;
        clipboard.set_text(St.ClipboardType.CLIPBOARD,'Retry after timeout');
        assert(await reader._getClipboardText(St.ClipboardType.CLIPBOARD)==='Retry after timeout',
            'PRIMARY clipboard: normal reads work after a timeout');
        let disconnected=false;
        const stalled={connect:()=>1,disconnect:()=>{disconnected=true;},
            get_mimetypes:()=>['text/plain'],transfer_async:()=>{}};
        let timedOut=false;
        try{
            await capture.capture({selection:stalled,clipboard,isCurrent:()=>true,
                copy:()=>{throw new Error('Must not copy before snapshot completion');}});
        }catch(error){timedOut=error.message.includes('Could not capture');}
        assert(timedOut&&disconnected&&capture._active===null,
            'Compatibility copy: real GLib timeout settles an unresponsive transfer and disconnects signals');
        assert(await captureSelected()==='Firefox selection 🌍','Compatibility copy: retry works after an unresponsive transfer');
        assert(await read()==='Retry after timeout','Compatibility copy: retry preserves the original clipboard');
        capture.destroy();captureDialog.destroy();this._dialog=null;
        const action=Object.create(PlyphExtension.prototype);
        Object.defineProperty(action,'path',{value:this.path});
        action._pendingClipboardReads=new Set();action._clipboard=clipboard;
        action._icon=new St.Icon();action._defaultIcon=null;
        action._hideFloatingButton=()=>{};action._clearPointerFeedback=()=>{};
        action._showFeedback=(message,state)=>{if(state==='error')throw new Error(message);};
        action._setIcon=()=>{};
        action._settings={get_boolean:key=>key==='preview-results',get_string:key=>key==='provider'?'ollama':key==='custom-providers'?'[]':''};
        let transformed=false;
        action._client={transform:async text=>{assert(text==='Native action input','Correct action receives captured selection');transformed=true;return 'Native corrected output';}};
        clipboard.set_text(St.ClipboardType.PRIMARY,'Native action input');
        await delay(100);
        await action._run('correct');await delay(100);
        assert(transformed&&action._previewDialog&&action._previewDialog._label.get_text()==='Native corrected output',
            'Correct action: selection to AI result opens the real preview');
        action._previewDialog.destroy();
        print('PLYPH-NATIVE: ALL CHECKS PASSED');await delay(150);global.context.terminate();
    }
}
