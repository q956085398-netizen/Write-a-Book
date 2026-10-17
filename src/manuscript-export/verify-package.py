"""Independent ZIP/OOXML package verification for T44 generated sample documents.
Usage: python src/manuscript-export/verify-package.py <fixture-directory>
No conversion, rendering, networking, or document content execution occurs.
"""
from pathlib import Path
import sys
import zipfile
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
RELS = '{http://schemas.openxmlformats.org/package/2006/relationships}'

def verify(path: Path) -> None:
    with zipfile.ZipFile(path) as package:
        assert package.testzip() is None, 'CRC verification failed'
        names = package.namelist()
        assert len(set(names)) == len(names), 'Duplicate package part'
        assert {'[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels'} <= set(names)
        for name in names:
            assert not name.startswith('/') and '..' not in Path(name).parts
            if name.endswith(('.xml', '.rels')):
                ET.fromstring(package.read(name))
        doc = ET.fromstring(package.read('word/document.xml'))
        text = ''.join(node.text or '' for node in doc.iter(W + 't'))
        assert '不能混入' not in text and '未选片段' not in text
        relationships = {node.attrib['Id']: node for node in ET.fromstring(package.read('word/_rels/document.xml.rels'))}
        for blip in doc.iter(A + 'blip'):
            relation = relationships[blip.attrib[R + 'embed']]
            media_name = 'word/' + relation.attrib['Target']
            assert media_name in names
            assert package.read(media_name).startswith((b'\x89PNG\r\n\x1a\n', b'\xff\xd8', b'GIF8'))
        numbering = ET.fromstring(package.read('word/numbering.xml'))
        seen_num = False
        for node in numbering:
            if node.tag == W + 'num':
                seen_num = True
            else:
                assert not seen_num, 'abstractNum must precede numbering instances'
        if path.name == '当前章.docx':
            assert '中文第二段' in text and '粗体中文' not in text and '末章正文' not in text and '主动片段' not in text
        else:
            for phrase in ['同名卷', '开篇章', '中文小标题', '粗体中文', '斜体与下划线', '官方链接', '引用内容', '第三项', '嵌套项目', '主动片段', '中篇章', '中文第二段']:
                assert phrase in text, phrase
            assert text.index('开篇章') < text.index('主动片段') < text.index('中篇章')
            assert len(list(doc.iter(A + 'blip'))) == 2
            assert list(doc.iter(W + 'b')) and list(doc.iter(W + 'i')) and list(doc.iter(W + 'u'))
            assert any(node.attrib.get('Target') == 'https://example.com/?a=1&b=2' for node in relationships.values())
            if path.name == '全书图文.docx':
                assert text.index('中篇章') < text.index('末章')
            else:
                assert '末章正文' not in text
        print(f'{path.name}: ZIP CRC, XML, relationships, Chinese, scope, order, images OK ({len(names)} parts)')

if __name__ == '__main__':
    folder = Path(sys.argv[1])
    for file in sorted(folder.glob('*.docx')):
        verify(file)
    txt = (folder / '全书图文.txt').read_text(encoding='utf-8-sig')
    assert txt.index('开篇章') < txt.index('主动片段') < txt.index('中篇章') < txt.index('末章')
    assert '不能混入' not in txt and '中文第一段' not in txt
    assert '粗体中文' in txt and '中文第二段' in txt
    print('全书图文.txt: UTF-8 BOM, Chinese, explicit fragments, directory order OK')
