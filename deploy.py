"""
deploy.py — publish docs/ to the gh-pages branch as a single squashed commit.

Why squash + force-push: the section snapshot (data.json.enc, ~12 MB) is rebuilt
daily. Committing it to history every day would bloat the repo to multiple GB a
year (the exact problem the CIM tracker hit). Instead we build docs/ in a throwaway
temp git repo, make ONE commit, and force-push it to gh-pages — so neither main nor
gh-pages ever accumulates history. main keeps only source (docs/ is gitignored).
"""
import os
import subprocess
import tempfile
import shutil
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, 'docs')
REMOTE = None  # filled from the repo's origin at runtime


def _origin_url():
    return subprocess.check_output(['git', '-C', HERE, 'remote', 'get-url', 'origin']).decode().strip()


def publish_pages():
    if not os.path.isdir(DOCS) or not os.path.exists(os.path.join(DOCS, 'index.html')):
        raise RuntimeError('docs/ not built — run export_static.py first')
    origin = _origin_url()
    msg = 'Publish ' + datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
    tmp = tempfile.mkdtemp(prefix='sectrk_pages_')
    try:
        # copy the built site into a clean tree
        for name in os.listdir(DOCS):
            src = os.path.join(DOCS, name)
            dst = os.path.join(tmp, name)
            if os.path.isdir(src):
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
        # .nojekyll so GitHub Pages serves files starting with _ and skips Jekyll
        open(os.path.join(tmp, '.nojekyll'), 'w').close()
        run = lambda *a: subprocess.run(['git', '-C', tmp, *a], check=True,
                                        capture_output=True, text=True)
        run('init', '-q')
        run('checkout', '-q', '-b', 'gh-pages')
        run('add', '-A')
        run('-c', 'user.name=section-tracker', '-c', 'user.email=noreply@northeastern.edu',
            'commit', '-q', '-m', msg)
        run('remote', 'add', 'origin', origin)
        run('push', '-q', '--force', 'origin', 'gh-pages')
        print(f'published gh-pages: {msg}')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    publish_pages()
