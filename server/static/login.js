"use strict";
const loginForm = document.querySelector("#loginForm"), registerForm = document.querySelector("#registerForm");
const errorBox = document.querySelector("#loginError");
function selectMode(register) {
  loginForm.hidden = register; registerForm.hidden = !register; errorBox.textContent = "";
  document.querySelector("#showLogin").setAttribute("aria-pressed", String(!register));
  document.querySelector("#showRegister").setAttribute("aria-pressed", String(register));
}
document.querySelector("#showLogin").onclick = () => selectMode(false);
document.querySelector("#showRegister").onclick = () => selectMode(true);
let pending = false;
async function authenticate(action, body) {
  if (pending) return;
  pending = true; errorBox.textContent = "";
  document.querySelectorAll(".login-card button").forEach(button => button.disabled = true);
  try {
    const response = await fetch(`/api/auth/${action}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    const data = await response.json();
    if (!response.ok) throw Error(data.message || "暂时无法进入，请稍后再试");
    location.replace("/");
  } catch (error) { errorBox.textContent = error instanceof TypeError ? "连接失败，请检查网络后重试。" : error.message; }
  finally { pending = false; document.querySelectorAll(".login-card button").forEach(button => button.disabled = false); }
}
for (const [form, action] of [[loginForm, "login"], [registerForm, "register"]]) {
  form.addEventListener("submit", event => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form)); body.username = body.username.trim();
    if (action === "register" && body.password !== body.confirm_password) { errorBox.textContent = "两次输入的密码不一致"; return; }
    authenticate(action, body);
  });
}
document.querySelector("#guestLogin").onclick = () => authenticate("guest", {});
if (new URLSearchParams(location.search).get("mode") === "register") selectMode(true);
