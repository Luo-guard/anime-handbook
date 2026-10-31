"""Validation for account-specific keyboard bindings (defaults live in keyboard.js)."""
import re
ACTIONS={"collection","schedule","timeline","statistics","ranking","settings","previous","next","sidebar","shutdown","search","new_record","new_ranking","refresh_schedule","filter"}
def normalize_shortcuts(value):
    if not isinstance(value,dict) or not isinstance(value.get("enabled",True),bool):
        raise ValueError("快捷键设置格式错误")
    bindings=value.get("bindings",{})
    if not isinstance(bindings,dict) or set(bindings)-ACTIONS:
        raise ValueError("快捷键操作无效")
    result={};used=set()
    for action,item in bindings.items():
        if not isinstance(item,dict) or not isinstance(item.get("enabled"),bool) or not isinstance(item.get("key"),str):
            raise ValueError("快捷键格式错误")
        key=item["key"]
        parts=key.split("+")
        modifiers=parts[:-1];base=parts[-1]
        valid_base=(len(base)==1 and base.isascii() and base.isprintable() and base not in {" ","+"}) or base in {"MouseBack","MouseForward","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","PageUp","PageDown","Escape","Space","Backspace","Delete"} or re.fullmatch(r"F(?:[1-9]|1[0-2])",base)
        if key and (not valid_base or modifiers != [m for m in ["Ctrl","Alt","Shift","Meta"] if m in modifiers]):
            raise ValueError("快捷键按键无效")
        if item["enabled"] and key:
            if key in used:raise ValueError("启用的快捷键不能重复")
            used.add(key)
        result[action]={"enabled":item["enabled"],"key":key}
    return {"enabled":value.get("enabled",True),"bindings":result}
