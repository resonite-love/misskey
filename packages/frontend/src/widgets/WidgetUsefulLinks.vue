<template>
  <MkContainer class="">
    <template #header>Resonite実用的リンク集</template>
    <div class="widget-useful-links compact">
      <h2>公式</h2>
      <ul>
        <li>
          <a
            href="https://resonite.com/"
            target="_blank"
            rel="noopener"
            title="各種リンクのほか、公式グッズストアやサブスクリプションなどのリンクがあります"
          >公式サイト</a>
          <span>各種リンク・グッズ・サブスク</span>
        </li>
        <li>
          <a
            href="https://resonite.com/policies/"
            target="_blank"
            rel="noopener"
            title="利用規約やガイドライン、プライバシーポリシーなどがあります"
          >ポリシー</a>
          <span>利用規約・ガイドライン</span>
        </li>
        <li>
          <a
            href="https://discord.gg/resonite"
            target="_blank"
            rel="noopener"
            title="公式のアナウンスやアップデート情報、開発ログが投稿されます。Resonite最大のコミュニティでもあるため雑談や質問がかなり活発で、Resoniteチーム（運営）の人による投稿もかなり多いです。運営や開発に関するちょっとした質問にも答えてくれる印象があります"
          >公式Discord</a>
          <span>質問とか・DevLogとか</span>
        </li>
        <li>
          <a
            href="https://wiki.resonite.com/Main_Page/ja"
            target="_blank"
            rel="noopener"
            title="Resoniteの様々な情報を見ることができるwikiです。Resoniteのユーザーであれば誰でも編集・翻訳ができます"
          >公式wiki</a>
          <span>たくさんの情報が翻訳中!</span>
        </li>
        <li>
          <a
            href="https://github.com/Yellow-Dog-Man/Resonite-Issues"
            target="_blank"
            rel="noopener"
            title="バグ報告や機能の要望などのフィードバックを行う場所です。新しくフィードバック（Issue）を作成したり、過去のフィードバックを確認できます。Issueを作成する際はガイドラインを守りましょう。Resonite開発の優先順位の決定に、Issueがどのように考慮されるかはREADMEやHOW_WE_PRIORITIZE.mdで説明されています"
          >Resonite-Issues</a>
          <span>バグ報告・要望</span>
        </li>
      </ul>
      <h2>コミュニティ</h2>
      <ul>
        <li>
          <a
            href="https://discord.gg/resonite-japan"
            target="_blank"
            rel="noopener"
            title="イベントお知らせチャンネルや質問フォーラムがあります"
          >ResoniceJapan Discord</a>
          <span>日本Discordコミュニティ</span>
        </li>
        <li>
          <a
            href="https://resonite-jp-guide.zozoka.su"
            target="_blank"
            rel="noopener"
            title="Resoniteの基本的な機能の説明がまとめられた、チュートリアル向けのサイトです"
          >非公式日本語ガイド</a>
          <span>ぞぞかす製チュートリアル</span>
        </li>
        <li>
          <a
            href="https://dinosaur-fossil.hatenablog.com/entry/2024/09/11/215603"
            target="_blank"
            rel="noopener"
            title="アバターアップロードをする方法が一通り書かれた記事です"
          >アバター導入記事</a>
          <span>アップロード手順</span>
        </li>
        <li>
          <a
            href="https://note.com/sirojake/n/n849febb76f26"
            target="_blank"
            rel="noopener"
            title="Resoniteの始め方がインストールの方法から説明されています"
          >Resoniteのはじめかた</a>
          <span>インストール解説</span>
        </li>
      </ul>
      <div class="widget-useful-links-footer">
        <span>追加要望などは <b>@kokoa_</b> まで</span>
      </div>
    </div>
  </MkContainer>
</template>

<script lang="ts" setup>
import MkContainer from '@/components/MkContainer.vue';
import { i18n } from '@/i18n';
</script>

<style lang="scss" scoped>
.widget-useful-links.compact {
  padding: 4px;
}
.widget-useful-links.compact h2 {
  margin-top: 10px;
  margin-bottom: 4px;
  font-size: 1em;
  border-bottom: 1px solid #eee;
  padding-bottom: 1px;
}
.widget-useful-links.compact ul {
  list-style: none;
  padding: 0;
  margin: 0 0 6px 0;
}
.widget-useful-links.compact li {
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 0.5em;
  font-size: 0.97em;
}
.widget-useful-links.compact a {
  color: #3498db;
  word-break: break-all;
  font-weight: 500;
  transition: color 0.2s;
}
.widget-useful-links.compact a:hover {
  color: #217dbb;
}
.widget-useful-links.compact span {
  color: #555;
  font-size: 0.93em;
}
.widget-useful-links-footer {
  margin-top: 18px;
  text-align: right;
  font-size: 0.92em;
  color: #888;
}
</style>
