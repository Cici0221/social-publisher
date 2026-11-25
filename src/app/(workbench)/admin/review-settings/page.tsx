import { pageActor } from "@/server/auth";
import { reviewSettings } from "@/server/reviews";
import { ReviewSettingsForm } from "./review-settings-form";

export const metadata = { title: "审核设置" };

export default async function ReviewSettingsPage() {
  const actor = await pageActor("ADMIN");
  const settings = await reviewSettings(actor);
  return <div className="page-container">
    <header className="page-header">
      <div><h1>审核设置</h1><p className="muted">为宣传部工作台统一设置发布前审核。</p></div>
    </header>
    <ReviewSettingsForm {...settings} />
  </div>;
}
