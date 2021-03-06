import {
  Injectable, Inject, Injector, NgModuleFactory, SystemJsNgModuleLoader, ViewContainerRef
} from '@angular/core';

import { DOCUMENT } from '@angular/platform-browser';

/*
Lazy load an NgModule's .js bundle, instantiate a component
Refactored from demo: https://github.com/alexzuza/angular-cli-lazy

[Load an NgModule at runtime]

* Register LazyLoaderService & SystemJsNgModuleLoader as providers in your app.module.ts:
    import { LazyLoaderService } from './lazy-loader.service';
    import { NgModule, SystemJsNgModuleLoader } from '@angular/core';
    import { provideRoutes } from '@angular/router';
    providers: [
      LazyLoaderService,
      SystemJsNgModuleLoader,
      provideRoutes([
          { loadChildren: 'app/lazy/my-lazy.module#MyLazyModule' } // needed for production builds (not dev)
      ])
    ]

* Create a place in your DOM to load the new component onto:
    <div id='container'></div>

* Use LazyLoaderService to lazy-load an NgModule and Component, from inside an app component:
    import {LazyLoaderService} from "./lazy-loader.service";
    import {MyLazyComponent} from "./lazy/my-lazy.module"; // you can import the type, or omit this step and go typeless

    @ViewChild('container', {read: ViewContainerRef}) container: ViewContainerRef;
    constructor( private loader: LazyLoaderService, private root_container: ViewContainerRef ) {}
    async load() {
      this.lazymodule = await this.loader.load( 'MyLazyModule', app/lazy/my-lazy.module' );
      // do things
      this.lazycomp = this.lazymodule.create( "MyLazyComponent", container );      // add a new lazycomponent to the <div>
      this.lazycomp = this.lazymodule.create( "MyLazyComponent", root_container ); // add a new lazycomponent to the page root
      this.lazycomp = this.lazymodule.create( "MyLazyComponent" );                 // new component (dont add to DOM)
      this.lazycomp.instance.myMethod();                                         // how to access the methods of the component
    }
    ngOnDestroy() {
      this.lazycomp.destroy();   // remove the component from the DOM and delete
      this.lazymodule.destroy(); // destroys every load()'d instance of the module
    }


[Create a Component and NgModule to lazy-load]:

  import { Component, NgModule } from '@angular/core';
  import { CommonModule } from '@angular/common';
  @Component({
    selector: 'lazy-comp',
    template: ``
  })
  export class MyLazyComponent {
    myMethod() {}
  }
  @NgModule({
    imports: [CommonModule],
    declarations: [MyLazyComponent],    // refer to your lazyload component
    entryComponents: [MyLazyComponent]
  })
  export class MyLazyModule {
    static creatableComponents = { MyLazyComponent, }; //  we use this convention to add components that can be created
  }
*/

// Dynamically load an NgModule's corresponding .js bundle
// This is a service which allows SystemJsNgModuleLoader and Injector injected in the constructor for convenience
@Injectable()
export class LazyLoaderService {
  cache:any = {};

  constructor( private loader: SystemJsNgModuleLoader, private inj: Injector, @Inject(DOCUMENT) private readonly document: any ) {}

  // load a NgModule given the path to it's .ts file (e.g. 'app/lazy/lazy.module#LazyModule')
  // if it's already been loaded before, it'll return a cached version.
  // example:
  //   let lazymodule = await this.loader.load( 'app/lazy/lazy.module#LazyModule' );
  //   let component = lazymodule.create( "LazyComponent" );
  async load( moduleName: string, moduleFilename: string ) : Promise<any> {
    let moduleURL = moduleFilename + "#" + moduleName; // they lookup the module in the bundle using URL hash notation
    let ths = this;
    return new Promise( (rs, rj) => {
      try {
        this.loader.load( moduleURL ).then((moduleFactory: NgModuleFactory<any>) => {
          if (this.cache[moduleURL])
            return rs( this.cache[moduleURL] );

          console.info( "Loading Module ", moduleURL );
          const moduleRef = moduleFactory.create( this.inj );

          // pull out the module's component factories into an object keyed by component name
          // e.g. { "LazyComponent": { type: LazyComponent, factory: ComponentFactoryBoundToModule } }
          const entryComponents = (<any>moduleFactory.moduleType).creatableComponents; // creatable components exposed by the module (TODO: would be nice to read NgModule.entryComponents but it doesn't seem to exist)
          const compFactoryArray = Object.keys( entryComponents ).map( key => { return { [key]: { type: entryComponents[key], factory: moduleRef.componentFactoryResolver.resolveComponentFactory( entryComponents[key] ) } }; } );
          const compFactory = Object.assign( {}, ...compFactoryArray );

          // define a module to return to the user that allows them to create() components
          const moduleBundle = {
            name: moduleName,
            url: moduleURL,
            factory: compFactory,
            moduleRef: moduleRef,
            moduleType: (<any>moduleFactory.moduleType),
            // method to create components (see entry)
            create: (componentType: string, viewRef: ViewContainerRef) => viewRef ? viewRef.createComponent( compFactory[componentType].factory ) : compFactory[componentType].factory.create( this.inj ),
            // questionable how useful this is, the x.xxxx.chunk.js doesn't seem to actually unload.
            destroy: function() { ths.unload( this ); }
          };

          this.cache[moduleURL] = moduleBundle;
          return rs( moduleBundle );
        });
      } catch (err) {
        return rs( undefined );
      }
    });
  }

  // unload the cached module
  // NOTE: questionable how useful this is, the .js module doesn't seem to unload.
  // example:
  //   this.loader.unload( lazymodule );
  async unload( moduleBundle ) {
    if (this.cache[moduleBundle.url]) {
      moduleBundle.name += "-unloaded";
      moduleBundle.unloaded = true;
      moduleBundle.moduleRef.destroy();
      delete moduleBundle.factory;
      moduleBundle.factory = undefined;
      delete this.cache[moduleBundle.url];
    }
  }

  // lazy load a js script (e.g. such as jquery or pdfjs)
  // add script to .angular-cli.json with lazy attribute
  // "scripts": [
  //   { "input": "../node_modules/jquery/dist/jquery.js", "output": "jquery", "lazy": true }
  // ],
  // You'll get an jquery.bundle.js file in the build output which you can lazy-load js modules with
  // - loadJs()
  //   or...
  // - import() if you use "esnext" language generation:
  //    import('jquery')
  //      .then((module: Function) => {
  //        window['$'] = module;
  //    });
  //   or...
  // - require() will embed the js module into the current x.xx.chunk.js, so use require() in a NgModule and use load() to lazy-load
  //
  // you can access any globals (e.g. html2canvas) created by the load, with:
  // - (<any>global).html2canvas
  private loadedLibraries = {};
  public loadJs(url: string): Promise<any> {
    return new Promise( (rs, rj) => {
      if (this.loadedLibraries[url]) {
        return this.loadedLibraries[url];
      }

      const script = this.document.createElement('script');
      script.type = 'text/javascript';
      script.onload = () => {
        this.loadedLibraries[url] = script;
        return rs( script );
      };
      script.src = url;
      this.document.body.appendChild(script);  // could use head instead
    });
  }
}
