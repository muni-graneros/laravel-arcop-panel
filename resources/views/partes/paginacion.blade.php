{{-- Paginador propio: la vista Tailwind por defecto de Laravel pinta a la vez el
     bloque móvil y el de escritorio en un panel que no carga Tailwind —dos
     «Siguiente»— y sin contraste garantizado. Este usa las clases arcop-*, el
     objetivo táctil de 2.75rem de los botones y anuncia la página actual. --}}
@if ($paginator->hasPages())
    <nav class="arcop-paginacion" aria-label="Paginación de solicitudes">
        <ul class="arcop-paginacion__lista">
            @if ($paginator->onFirstPage())
                <li><span class="arcop-boton arcop-boton--inactivo" aria-disabled="true">Anterior</span></li>
            @else
                <li><a class="arcop-boton" href="{{ $paginator->previousPageUrl() }}" rel="prev">Anterior</a></li>
            @endif

            @foreach ($elements as $elemento)
                @if (is_string($elemento))
                    <li><span class="arcop-paginacion__salto" aria-hidden="true">{{ $elemento }}</span></li>
                @endif

                @if (is_array($elemento))
                    @foreach ($elemento as $pagina => $url)
                        @if ($pagina == $paginator->currentPage())
                            <li>
                                <a class="arcop-boton arcop-boton--principal" href="{{ $url }}" aria-current="page">
                                    {{ $pagina }}<span class="arcop-sr">, página actual</span>
                                </a>
                            </li>
                        @else
                            <li>
                                <a class="arcop-boton" href="{{ $url }}">
                                    {{ $pagina }}<span class="arcop-sr">, ir a la página</span>
                                </a>
                            </li>
                        @endif
                    @endforeach
                @endif
            @endforeach

            @if ($paginator->hasMorePages())
                <li><a class="arcop-boton" href="{{ $paginator->nextPageUrl() }}" rel="next">Siguiente</a></li>
            @else
                <li><span class="arcop-boton arcop-boton--inactivo" aria-disabled="true">Siguiente</span></li>
            @endif
        </ul>
        <p class="arcop-paginacion__resumen">
            Mostrando {{ $paginator->firstItem() }}–{{ $paginator->lastItem() }} de {{ $paginator->total() }}
        </p>
    </nav>
@endif
