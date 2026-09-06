.PHONY: all site pdf pdf-all check new app clean serve
all: pdf
site:
	python3 build.py --no-latex
pdf:
	python3 build.py --pdf
pdf-all:
	python3 build.py --pdf --all
check:
	python3 build.py --check
new:
	python3 build.py --new
app:
	python3 app.py
serve: site
	cd .. && python3 -m http.server 8000
clean:
	rm -rf build
