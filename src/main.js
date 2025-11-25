import "./assets/main.css";

import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import ChatAiWindow from "./components/ChatAiWindow.vue";
import TreeNode from "./components/workspace/TreeNode.vue";

const app = createApp(App);
app.use(router);
app.component("ChatAiWindow", ChatAiWindow);
app.component("TreeNode", TreeNode);
app.mount("#app");
