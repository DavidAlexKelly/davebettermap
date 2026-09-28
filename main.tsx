import { OsdkProvider } from "@osdk/react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./index.css";
import client from "./auth/client";
import { router } from "./auth/router";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <OsdkProvider client={client}>
    <RouterProvider router={router} />
  </OsdkProvider>,
);
