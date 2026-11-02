import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import PlyphExtension from './subject.js';
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
        const drag=async(label)=>{
            await delay(120);
            const before=d._scroll.height;
            const [x,y]=d._divider.get_transformed_position();const [width,height]=d._divider.get_transformed_size();
            await moveTo(50,50);
            for(let attempt=0;attempt<4;attempt++){
                const [px,py]=global.get_pointer();pointer.notify_relative_motion(time(),x+width/2-px,y+height/2-py);await delay(50);
            }
            pointer.notify_button(time(),1,Clutter.ButtonState.PRESSED);await delay(80);
            for(let step=0;step<4;step++){pointer.notify_relative_motion(time(),0,20);await delay(40);}
            pointer.notify_button(time(),1,Clutter.ButtonState.RELEASED);await delay(100);
            assert(d._scroll.height>before+30,`${label}: native mouse drag resizes result (${before} -> ${d._scroll.height}, divider ${x},${y},${width},${height})`);
            assert(!d._dividerGrab,`${label}: releases pointer grab`);
        };
        d._label.clutter_text.set_text('Short');d._splitRatio=null;d._resizePreview();await drag('Short result');
        d._label.clutter_text.set_text(('Long result with multiple lines.\n').repeat(60));d._splitRatio=null;d._resizePreview();await drag('Long result');
        d._toggleExpanded({});d._splitRatio=null;d._resizePreview();await drag('Enlarged result');
        d._divider.grab_key_focus();const before=d._scroll.height;
        await combo(Clutter.KEY_Up);assert(d._scroll.height<before,'Divider keyboard resizing');
        await combo(Clutter.KEY_Home);assert(d._splitRatio===null,'Divider keyboard reset');
        d.destroy();this._dialog=null;await delay(120);
        const error=new ErrorDialog('Readable error',()=>{});this._dialog=error;error.open();await delay(150);
        const findLabel=root=>{if(root instanceof St.Label&&root.clutter_text.get_text()==='Readable error')return root;for(const child of root.get_children()){const found=findLabel(child);if(found)return found;}return null;};
        const errorLabel=findLabel(error.contentLayout);
        await copy(errorLabel,'Error dialog','Readable error');error.close();this._dialog=null;await delay(120);
        let submitted='';let closed=false;
        const ask=new AskDialog(text=>{submitted=text;},null,()=>{closed=true;});this._dialog=ask;ask.open();await delay(150);
        ask._entry.clutter_text.grab_key_focus();await combo(Clutter.KEY_Return);
        assert(!ask._finished&&!closed&&ask._inputError.visible,'Empty Ask stays open with feedback');
        await edit(ask._entry,'Ask input');
        ask._entry.set_text('  Explain this  ');ask._entry.clutter_text.grab_key_focus();await combo(Clutter.KEY_Return);
        assert(submitted==='Explain this'&&closed,'Valid Ask submits after empty attempt');this._dialog=null;
        print('PLYPH-NATIVE: ALL CHECKS PASSED');await delay(150);global.context.terminate();
    }
}
